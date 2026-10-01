import { randomInt } from 'node:crypto';
import { type ExerciseStep, type ExerciseV1, exerciseV1 } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/exercises';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { studyableResource, type Tx } from '../content/releases';
import {
  type Judgement,
  judge,
  parseResponse,
  savedByComplete,
  viewStep,
} from '../exercises/evaluate';
import { invalid, notFound, type Outcome } from '../outcome';
import type { Db } from './client';
import {
  classMemberships,
  exerciseAttempts,
  exerciseEvents,
  resourceRevisions,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * Practice attempts of one class (§9). Every function takes the resolved `ClassScope`; an
 * attempt is readable and writable by its student only, and instructors read it through
 * `reviewAttempts`. Events are appended under a row lock on the attempt, so concurrent
 * clicks cannot interleave sequence numbers or complete a step twice.
 */

type Help = z.output<typeof contracts.exerciseHelp>;
type AttemptView = z.input<typeof contracts.attemptView>;
type ReviewAttempt = z.input<typeof contracts.reviewAttempt>;
type AttemptRow = typeof exerciseAttempts.$inferSelect;
type EventRow = typeof exerciseEvents.$inferSelect;
type Refusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; message: string };
type NewEvent = {
  stepId: string | null;
  kind: EventRow['kind'];
  payload?: Record<string, unknown>;
};

const helpRank: Help[] = ['independent', 'with_hints', 'solution_shown'];
const worst = (helps: Help[]): Help =>
  helps.reduce((a, b) => (helpRank.indexOf(b) > helpRank.indexOf(a) ? b : a), 'independent');

interface StepState {
  checks: { response: unknown; correct: boolean; at: string }[];
  hintsShown: number;
  solutionShown: boolean;
  help: Help | null;
  response: unknown;
  feedback: string | null;
  finalResponse: unknown;
  compared: number[];
}

const emptyState = (): StepState => ({
  checks: [],
  hintsShown: 0,
  solutionShown: false,
  help: null,
  response: null,
  feedback: null,
  finalResponse: null,
  compared: [],
});

/** Folds an attempt's events, in order, into per-step state. */
function replay(definition: ExerciseV1, events: EventRow[]): Map<string, StepState> {
  const state = new Map(definition.steps.map((step) => [step.id, emptyState()]));
  for (const event of events) {
    const s = event.stepId ? state.get(event.stepId) : undefined;
    if (!s) continue;
    const p = event.payload as Record<string, unknown>;
    if (event.kind === 'check') {
      s.checks.push({
        response: p.response,
        correct: p.correct === true,
        at: event.createdAt.toISOString(),
      });
      s.response = p.response;
      s.feedback = p.feedback as string;
      const value = (p.response as { value?: unknown } | null)?.value;
      if (typeof value === 'number' && !s.compared.includes(value)) s.compared.push(value);
    } else if (event.kind === 'hint_shown') s.hintsShown += 1;
    else if (event.kind === 'solution_revealed') s.solutionShown = true;
    else if (event.kind === 'step_completed' && s.help === null) {
      s.help = p.help as Help;
      s.finalResponse = p.response ?? s.response;
      if ('response' in p) {
        s.response = p.response;
        s.feedback = (p.feedback as string | undefined) ?? s.feedback;
      }
    }
  }
  return state;
}

function toView(row: AttemptRow, definition: ExerciseV1, events: EventRow[]): AttemptView {
  const state = replay(definition, events);
  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceRevisionId: row.resourceRevisionId,
    number: row.number,
    seed: row.seed,
    completion: row.completion,
    completedAt: row.completedAt?.toISOString() ?? null,
    startedAt: row.createdAt.toISOString(),
    steps: definition.steps.map((step) => {
      const s = state.get(step.id) ?? emptyState();
      return {
        ...viewStep(step, row.seed),
        status: s.help ? 'completed' : 'pending',
        help: s.help,
        checks: s.checks.length,
        hints: step.hints.slice(0, s.hintsShown),
        solution: s.solutionShown ? (step.solution ?? null) : null,
        response: s.response,
        feedback: s.feedback,
        ...(step.kind === 'simulation' && { compared: s.compared }),
      };
    }),
  };
}

/** The `exercise.v1` content of a revision; undefined if it is not a valid exercise. */
async function definitionOf(db: Db | Tx, revisionId: string) {
  const [row] = await db
    .select({ content: resourceRevisions.content, type: resourceRevisions.type })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  if (row?.type !== 'exercise') return undefined;
  const parsed = exerciseV1.safeParse(row.content);
  return parsed.success ? parsed.data : undefined;
}

const eventsOf = (db: Db | Tx, scope: ClassScope, attemptIds: string[]) =>
  db
    .select()
    .from(exerciseEvents)
    .where(and(forClass(scope, exerciseEvents), inArray(exerciseEvents.attemptId, attemptIds)))
    .orderBy(asc(exerciseEvents.attemptId), asc(exerciseEvents.seq));

const ownAttempts = (scope: ClassScope) =>
  and(forClass(scope, exerciseAttempts), eq(exerciseAttempts.userId, scope.user.id));

async function currentAttempt(db: Db | Tx, scope: ClassScope, resourceId: string) {
  const [row] = await db
    .select()
    .from(exerciseAttempts)
    .where(
      and(
        ownAttempts(scope),
        eq(exerciseAttempts.resourceId, resourceId),
        isNull(exerciseAttempts.supersededAt),
      ),
    );
  return row;
}

async function viewOf(db: Db | Tx, scope: ClassScope, row: AttemptRow) {
  const definition = await definitionOf(db, row.resourceRevisionId);
  if (!definition) throw new Error(`attempt ${row.id} references an invalid exercise`);
  return toView(row, definition, await eventsOf(db, scope, [row.id]));
}

/** Inserts attempt `number` on the class's pinned revision, or returns the one that won a race. */
async function startAttempt(
  db: Db | Tx,
  scope: ClassScope,
  resourceId: string,
  revisionId: string,
  number: number,
  now: Date,
) {
  const [row] = await db
    .insert(exerciseAttempts)
    .values({
      classId: scope.classId,
      userId: scope.user.id,
      isPreview: scope.membership.isPreview,
      resourceId,
      resourceRevisionId: revisionId,
      number,
      seed: randomInt(0, 2 ** 31 - 1),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? (await currentAttempt(db, scope, resourceId));
}

/** Resume the caller's current attempt on an exercise of the class's release, or start one. */
export async function openExercise(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<AttemptView>> {
  const resource = await studyableResource(db, scope, resourceId);
  if (resource?.type !== 'exercise') return notFound;
  if (!(await definitionOf(db, resource.revisionId))) {
    return invalid('This exercise cannot be opened: its definition is not valid');
  }
  const row =
    (await currentAttempt(db, scope, resourceId)) ??
    (await startAttempt(db, scope, resourceId, resource.revisionId, 1, now));
  if (!row) throw new Error('exercise attempt insert returned no row');
  return { ok: true, value: await viewOf(db, scope, row) };
}

interface Context {
  tx: Tx;
  attempt: AttemptRow;
  definition: ExerciseV1;
  state: Map<string, StepState>;
  /** The revision the class studies now (a restart starts on it). */
  revisionId: string;
}

type Action = (ctx: Context) => Promise<Refusal | { events: NewEvent[]; next?: AttemptRow }>;

/**
 * Runs `action` on the caller's current attempt under a row lock, appends the events it
 * returns, and records the attempt's completion when its last step completes. A superseded
 * attempt answers 409 with the current one, so a stale tab cannot act on old work.
 */
async function act(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  now: Date,
  action: Action,
): Promise<Outcome<AttemptView>> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(exerciseAttempts)
      .where(and(ownAttempts(scope), eq(exerciseAttempts.id, attemptId)))
      .for('update');
    if (!attempt) return notFound;
    const resource = await studyableResource(tx, scope, attempt.resourceId);
    if (!resource) return notFound;
    if (attempt.supersededAt) {
      const current = await currentAttempt(tx, scope, attempt.resourceId);
      if (!current) return notFound;
      return { ok: false, reason: 'conflict', current: await viewOf(tx, scope, current) };
    }
    const definition = await definitionOf(tx, attempt.resourceRevisionId);
    if (!definition) return notFound;
    const events = await eventsOf(tx, scope, [attempt.id]);
    const state = replay(definition, events);
    const ctx = { tx, attempt, definition, state, revisionId: resource.revisionId };
    const result = await action(ctx);
    if ('ok' in result) return result;

    let seq = events.at(-1)?.seq ?? 0;
    const added =
      result.events.length === 0
        ? []
        : await tx
            .insert(exerciseEvents)
            .values(
              result.events.map((e) => ({
                classId: scope.classId,
                attemptId: attempt.id,
                stepId: e.stepId,
                kind: e.kind,
                payload: e.payload ?? {},
                seq: ++seq,
                createdAt: now,
              })),
            )
            .returning();
    const all = [...events, ...added.sort((a, b) => a.seq - b.seq)];
    const after = replay(definition, all);
    const helps = [...after.values()].map((s) => s.help);
    let row = attempt;
    if (!attempt.completion && helps.every((h) => h !== null)) {
      const [updated] = await tx
        .update(exerciseAttempts)
        .set({ completion: worst(helps as Help[]), completedAt: now })
        .where(and(ownAttempts(scope), eq(exerciseAttempts.id, attempt.id)))
        .returning();
      if (updated) row = updated;
    }
    if (result.next) return { ok: true, value: await viewOf(tx, scope, result.next) };
    return { ok: true, value: toView(row, definition, all) };
  });
}

/** The step named `stepId` if it is completed or the first incomplete one (§9: one active step). */
function activeStep(ctx: Context, stepId: string): Refusal | { ok: true; value: ExerciseStep } {
  const index = ctx.definition.steps.findIndex((s) => s.id === stepId);
  const step = ctx.definition.steps[index];
  if (!step) return invalid('This exercise has no such step');
  const firstOpen = ctx.definition.steps.findIndex((s) => ctx.state.get(s.id)?.help === null);
  if (firstOpen !== -1 && index > firstOpen) return invalid('Complete the earlier steps first');
  return { ok: true, value: step };
}

const helpFor = (s: StepState): Help =>
  s.solutionShown ? 'solution_shown' : s.hintsShown > 0 ? 'with_hints' : 'independent';

const stateOf = (ctx: Context, step: ExerciseStep) => ctx.state.get(step.id) ?? emptyState();

/** Check answer; `result` is set when the check was recorded. */
export async function checkStep(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  input: { stepId: string; response?: unknown },
  now: Date,
): Promise<{ outcome: Outcome<AttemptView>; result?: Judgement }> {
  let result: Judgement | undefined;
  const outcome = await act(db, scope, attemptId, now, async (ctx) => {
    const found = activeStep(ctx, input.stepId);
    if (!found.ok) return found;
    const step = found.value;
    if (savedByComplete(step)) return invalid('Save this step’s written response instead');
    const parsed = parseResponse(step, input.response);
    if (!parsed.ok) return invalid(parsed.message);
    const s = stateOf(ctx, step);
    result = judge(step, parsed.value, s.compared);
    const events: NewEvent[] = [
      { stepId: step.id, kind: 'check', payload: { response: parsed.value, ...result } },
    ];
    if (result.correct && s.help === null) {
      events.push({ stepId: step.id, kind: 'step_completed', payload: { help: helpFor(s) } });
    }
    return { events };
  });
  return { outcome, result };
}

export async function showHint(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  input: { stepId: string },
  now: Date,
) {
  return act(db, scope, attemptId, now, async (ctx) => {
    const found = activeStep(ctx, input.stepId);
    if (!found.ok) return found;
    const s = stateOf(ctx, found.value);
    if (s.hintsShown >= found.value.hints.length) return invalid('No more hints for this step');
    return {
      events: [{ stepId: input.stepId, kind: 'hint_shown', payload: { index: s.hintsShown } }],
    };
  });
}

/**
 * Show solution completes a checked step with help. A written step (text, code) still needs
 * its own response: seeing a model answer does not save an explanation (A23).
 */
export async function showSolution(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  input: { stepId: string },
  now: Date,
) {
  return act(db, scope, attemptId, now, async (ctx) => {
    const found = activeStep(ctx, input.stepId);
    if (!found.ok) return found;
    const step = found.value;
    if (step.solution === undefined) return invalid('This step has no solution');
    const s = stateOf(ctx, step);
    if (s.solutionShown) return { events: [] };
    const events: NewEvent[] = [{ stepId: step.id, kind: 'solution_revealed' }];
    if (s.help === null && !savedByComplete(step)) {
      events.push({ stepId: step.id, kind: 'step_completed', payload: { help: 'solution_shown' } });
    }
    return { events };
  });
}

export async function completeStep(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  input: { stepId: string; response: string },
  now: Date,
) {
  return act(db, scope, attemptId, now, async (ctx) => {
    const found = activeStep(ctx, input.stepId);
    if (!found.ok) return found;
    const step = found.value;
    if (!savedByComplete(step)) return invalid('Check this step’s answer instead');
    const s = stateOf(ctx, step);
    if (s.help !== null) return invalid('This step is already complete');
    const parsed = parseResponse(step, input.response);
    if (!parsed.ok) return invalid(parsed.message);
    const { feedback } = judge(step, parsed.value);
    const payload = { help: helpFor(s), response: parsed.value, feedback };
    return { events: [{ stepId: step.id, kind: 'step_completed', payload }] };
  });
}

/** Start again: the attempt is superseded, keeping every event; a new one starts (§9). */
export async function restartExercise(db: Db, scope: ClassScope, attemptId: string, now: Date) {
  return act(db, scope, attemptId, now, async (ctx) => {
    const { tx, attempt } = ctx;
    await tx
      .update(exerciseAttempts)
      .set({ supersededAt: now })
      .where(and(ownAttempts(scope), eq(exerciseAttempts.id, attempt.id)));
    const next = await startAttempt(
      tx,
      scope,
      attempt.resourceId,
      ctx.revisionId,
      attempt.number + 1,
      now,
    );
    if (!next) throw new Error('exercise restart inserted no attempt');
    return { events: [{ stepId: null, kind: 'restart', payload: { next: next.id } }], next };
  });
}

/**
 * Instructor review: students' attempts (preview principals excluded) with every check,
 * hint count, solution reveal and completion level, newest attempt first per student.
 */
export async function reviewAttempts(
  db: Db,
  scope: ClassScope,
  resourceId: string,
): Promise<ReviewAttempt[]> {
  const rows = await db
    .select({ attempt: exerciseAttempts, name: users.name })
    .from(exerciseAttempts)
    .innerJoin(users, eq(users.id, exerciseAttempts.userId))
    .innerJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, exerciseAttempts.classId),
        eq(classMemberships.userId, exerciseAttempts.userId),
      ),
    )
    .where(
      and(
        forClass(scope, exerciseAttempts),
        eq(exerciseAttempts.resourceId, resourceId),
        eq(exerciseAttempts.isPreview, false),
        eq(classMemberships.role, 'student'),
      ),
    )
    .orderBy(asc(users.name), asc(exerciseAttempts.userId), desc(exerciseAttempts.number));
  if (rows.length === 0) return [];
  const events = await eventsOf(
    db,
    scope,
    rows.map((r) => r.attempt.id),
  );
  const definitions = new Map<string, ExerciseV1 | undefined>();
  const review: ReviewAttempt[] = [];
  for (const { attempt, name } of rows) {
    if (!definitions.has(attempt.resourceRevisionId)) {
      definitions.set(
        attempt.resourceRevisionId,
        await definitionOf(db, attempt.resourceRevisionId),
      );
    }
    const definition = definitions.get(attempt.resourceRevisionId);
    if (!definition) continue;
    const state = replay(
      definition,
      events.filter((e) => e.attemptId === attempt.id),
    );
    review.push({
      id: attempt.id,
      student: { id: attempt.userId, name },
      number: attempt.number,
      resourceRevisionId: attempt.resourceRevisionId,
      seed: attempt.seed,
      startedAt: attempt.createdAt.toISOString(),
      completion: attempt.completion,
      completedAt: attempt.completedAt?.toISOString() ?? null,
      restarted: attempt.supersededAt !== null,
      steps: definition.steps.map((step) => {
        const s = state.get(step.id) ?? emptyState();
        return {
          id: step.id,
          title: step.title,
          kind: step.kind,
          status: s.help ? 'completed' : 'pending',
          help: s.help,
          checks: s.checks,
          hintsShown: s.hintsShown,
          solutionShown: s.solutionShown,
          finalResponse: s.finalResponse,
        };
      }),
    });
  }
  return review;
}
