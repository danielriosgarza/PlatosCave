import { randomUUID } from 'node:crypto';
import { type RunnerJob, testV1 } from '@parallax/contracts';
import type { InstructorRun, StudentRun } from '@parallax/contracts/routes/runs';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { ClassManagerScope, ClassScope } from '../../auth/scope';
import type { RunnerRuntime } from '../../config';
import {
  buildRunnerJob,
  buildRunnerJobDetailed,
  type CheckSet,
  type CodeQuestion,
  codeHash,
  graderVersion,
  runtimeImage,
  type Snapshot,
} from '../../execution/job-builder';
import { PRIORITY, RESULT_QUEUE, RUN_QUEUE } from '../../execution/queues';
import { type LiveState, toInstructorView, toStudentView } from '../../execution/view';
import { classArchived, invalid, notFound, type Outcome } from '../../outcome';
import { audit } from '../audit';
import type { Db, Tx } from '../client';
import {
  classMemberships,
  executionJobs,
  executionResults,
  resourceRevisions,
  testAttempts,
  testSubmissions,
} from '../schema';
import { forClass, forOwnRows } from '../scoped';
import { reviewable } from '../tests';
import { type RunRow, recordFailure } from './results';
import { isLive, jobStates, type Queues, readState } from './status';

/**
 * Code runs of test attempts (docs/design/runner.md §2, §8.4–§8.7, §9). Every function takes the
 * resolved `ClassScope`; a student reaches only the `sample` runs of their own attempts. Rows
 * are committed before their job is sent, and every write to an unsettled row is a conditional
 * `UPDATE`, so a race between a send, a cancel, a result and a read leaves exactly one winner.
 */

/** What the run services need besides the database: the runner's queue and the runtimes. */
export interface ExecDeps {
  boss: PgBoss;
  runtimes: readonly RunnerRuntime[];
  log?: { error: (obj: object, msg: string) => void };
}

/** Sample runs per student, queued or running, across every class (§5). */
export const SAMPLE_RUN_CAP = 2;
const CAP_MESSAGE = 'Two runs are already queued or running. Wait for one to finish.';

type Ex = Db | Tx;
type AnyView = StudentRun | InstructorRun;
type ResultRow = typeof executionResults.$inferSelect;

const queuesOf = (deps: ExecDeps): Queues => ({
  boss: deps.boss,
  run: RUN_QUEUE,
  result: RESULT_QUEUE,
});

/** The code question of a revision, or undefined when the revision holds no such question. */
async function codeQuestionOf(
  ex: Ex,
  revisionId: string,
  questionId: string,
): Promise<CodeQuestion | undefined> {
  const [row] = await ex
    .select({ content: resourceRevisions.content, type: resourceRevisions.type })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  if (row?.type !== 'test') return undefined;
  const parsed = testV1.safeParse(row.content);
  if (!parsed.success) return undefined;
  const question = parsed.data.questions.find((q) => q.id === questionId);
  return question?.kind === 'code' ? question : undefined;
}

/**
 * `own`: the caller's attempt. `class`: any attempt of the class, for the grading hook, which
 * also grades a preview principal's submission. `reviewable`: what instructor review, grading
 * and export read (`reviewable`, db/tests.ts): a real student's attempt, removed students
 * included, never a preview or non-student attempt.
 */
type AttemptAccess = 'own' | 'class' | 'reviewable';

async function attemptOf(ex: Ex, scope: ClassScope, attemptId: string, access: AttemptAccess) {
  if (access === 'reviewable') {
    const [found] = await ex
      .select({ attempt: testAttempts })
      .from(testAttempts)
      .leftJoin(
        classMemberships,
        and(
          eq(classMemberships.classId, testAttempts.classId),
          eq(classMemberships.userId, testAttempts.userId),
        ),
      )
      .where(and(reviewable(scope), eq(testAttempts.id, attemptId)));
    return found?.attempt;
  }
  const [row] = await ex
    .select()
    .from(testAttempts)
    .where(
      and(
        forClass(scope, testAttempts),
        eq(testAttempts.id, attemptId),
        access === 'own' ? eq(testAttempts.userId, scope.user.id) : undefined,
      ),
    );
  return row;
}

/** A student reads only their own attempts; instructors read the class's reviewable attempts. */
const attemptFor = (ex: Ex, scope: ClassScope, attemptId: string) =>
  attemptOf(ex, scope, attemptId, scope.role === 'student' ? 'own' : 'reviewable');

/** Runs of an attempt the caller may see: for a student, only their own sample runs. */
const visibleRuns = (scope: ClassScope, attemptId: string) =>
  and(
    forClass(scope, executionJobs),
    eq(executionJobs.attemptId, attemptId),
    scope.role === 'student'
      ? and(eq(executionJobs.userId, scope.user.id), eq(executionJobs.reason, 'sample'))
      : undefined,
  );

async function resultOf(ex: Ex, scope: ClassScope, jobId: string): Promise<ResultRow | null> {
  const [row] = await ex
    .select()
    .from(executionResults)
    .where(and(forClass(scope, executionResults), eq(executionResults.jobId, jobId)));
  return row ?? null;
}

/** The caller's view of a row: settled first when its job is no longer live (§8.5). */
async function viewOf(
  db: Db,
  deps: ExecDeps,
  scope: ClassScope,
  row: RunRow,
  now: Date,
): Promise<AnyView> {
  const read = await readState(db, queuesOf(deps), row, now);
  const result = read.live ? null : await resultOf(db, scope, row.id);
  return render(scope, read.row, result, read.live);
}

const render = (scope: ClassScope, row: RunRow, result: ResultRow | null, live?: LiveState) =>
  scope.role === 'student' ? toStudentView(row, result, live) : toInstructorView(row, result, live);

/** The job a row describes, rebuilt from its snapshot and pinned revision. */
async function jobOf(
  db: Db,
  deps: ExecDeps,
  row: RunRow,
): Promise<{ ok: true; job: RunnerJob } | { ok: false; message: string }> {
  const question = await codeQuestionOf(db, row.questionRevisionId, row.questionId);
  const runtime = deps.runtimes.find((r) => r.id === row.runtimeId);
  if (!question || !runtime) return { ok: false, message: 'the question or runtime is gone' };
  return buildRunnerJob(
    question,
    row.snapshot,
    row.checkSet,
    row.id,
    runtime,
    row.reason === 'replay' && isPinnable(row.imageRef) ? row.imageRef : undefined,
  );
}

/** A reference a job may pin (`runtime.image`): a repository digest or a Docker image id. */
const isPinnable = (ref: string) => /^sha256:[0-9a-f]{64}$|@sha256:[0-9a-f]{64}$/.test(ref);

/**
 * Sends a committed row's job with the id written on the row (§2 step 4), then marks the send
 * with a conditional update. When that update finds the row settled meanwhile (cancelled, or
 * `enqueue_failed` by a read), the job just created is cancelled; a send that throws settles the
 * row `enqueue_failed` and cancels by id too, in case the insert landed.
 */
async function sendRun(db: Db, deps: ExecDeps, row: RunRow, now: Date, job?: RunnerJob) {
  const built = job ? { ok: true as const, job } : await jobOf(db, deps, row);
  if (!built.ok) {
    await recordFailure(db, row, { kind: 'job_invalid', message: built.message }, now);
    return;
  }
  try {
    await deps.boss.send(RUN_QUEUE, built.job, {
      id: row.bossJobId,
      priority: row.priority,
      expireInSeconds: row.limits.wallSeconds + 60,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    });
  } catch (err) {
    deps.log?.error({ err, runId: row.id }, 'could not queue a run');
    await recordFailure(
      db,
      row,
      { kind: 'enqueue_failed', message: 'the run could not be queued' },
      now,
    );
    await deps.boss.cancel(RUN_QUEUE, row.bossJobId).catch(() => undefined);
    return;
  }
  const marked = await db
    .update(executionJobs)
    .set({ jobSentAt: now })
    .where(and(eq(executionJobs.id, row.id), eq(executionJobs.state, 'queued')))
    .returning({ state: executionJobs.state });
  if (marked.length === 0) await deps.boss.cancel(RUN_QUEUE, row.bossJobId);
}

async function rowOf(ex: Ex, scope: ClassScope, id: string): Promise<RunRow> {
  const [row] = await ex
    .select()
    .from(executionJobs)
    .where(and(forClass(scope, executionJobs), eq(executionJobs.id, id)));
  if (!row) throw new Error(`run ${id} vanished`);
  return row;
}

/** Fields of a new row common to every reason. */
function newRow(
  scope: ClassScope,
  attempt: { id: string; userId: string; resourceRevisionId: string },
  question: CodeQuestion,
  runtime: RunnerRuntime,
  snapshot: Snapshot,
  checkSet: CheckSet,
  now: Date,
) {
  return {
    id: randomUUID(),
    bossJobId: randomUUID(),
    classId: scope.classId,
    userId: attempt.userId,
    attemptId: attempt.id,
    questionRevisionId: attempt.resourceRevisionId,
    questionId: question.id,
    context: 'attempt' as const,
    checkSet,
    codeHash: codeHash(snapshot),
    snapshot,
    runtimeId: runtime.id,
    imageRef: runtimeImage(runtime),
    harnessVersion: runtime.harnessVersion,
    graderVersion: graderVersion(question, runtime),
    limits: { wallSeconds: 0, memoryMiB: 0, outputBytes: 0 },
    queuedAt: now,
  };
}

export type RunRefusal =
  | { ok: false; reason: 'too_many_runs'; active: number; message: string }
  | { ok: false; reason: 'attempt_closed' };

/**
 * Run sample tests (§2 steps 2–4): reuses an identical terminal run of this attempt, applies the
 * per-student cap under an advisory lock, supersedes a queued run of the same question, commits
 * the row and sends its job. `reused` tells the route which status to answer.
 */
export async function requestRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  attemptId: string,
  questionId: string,
  files: Snapshot['files'],
  now: Date,
): Promise<Outcome<StudentRun & { reused: boolean }> | RunRefusal> {
  const attempt = await attemptOf(db, scope, attemptId, 'own');
  if (!attempt) return notFound;
  const question = await codeQuestionOf(db, attempt.resourceRevisionId, questionId);
  if (!question) return notFound;
  if (attempt.state !== 'in_progress' || (attempt.deadlineAt && attempt.deadlineAt <= now)) {
    return { ok: false, reason: 'attempt_closed' };
  }
  if (scope.archived) return classArchived;
  const exec = deps();
  const runtime = exec.runtimes.find((r) => r.id === question.runtime);
  if (!runtime) return invalid('This question’s runtime is not available');
  const snapshot: Snapshot = { files: files.map((f) => ({ path: f.path, content: f.content })) };
  const fields = newRow(scope, attempt, question, runtime, snapshot, 'public', now);
  const built = buildRunnerJob(question, snapshot, 'public', fields.id, runtime);
  if (!built.ok) return invalid(built.message);

  // Identical code gives identical output: an earlier terminal run of this attempt answers.
  const [reusable] = await db
    .select()
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        eq(executionJobs.attemptId, attempt.id),
        eq(executionJobs.questionId, question.id),
        eq(executionJobs.reason, 'sample'),
        eq(executionJobs.checkSet, 'public'),
        eq(executionJobs.codeHash, fields.codeHash),
        eq(executionJobs.graderVersion, fields.graderVersion),
        inArray(executionJobs.state, ['passed', 'failed', 'time_limited', 'resource_exhausted']),
      ),
    )
    .orderBy(desc(executionJobs.queuedAt))
    .limit(1);
  if (reusable) {
    const result = await resultOf(db, scope, reusable.id);
    return { ok: true, value: { ...toStudentView(reusable, result), reused: true } };
  }

  const placed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`execution:${scope.user.id}`}))`);
    // The cap counts the student's own sample runs in every class (forOwnRows, §8.4) and writes
    // nothing to them; their jobs are looked up in one statement.
    const own = await tx
      .select({
        id: executionJobs.id,
        bossJobId: executionJobs.bossJobId,
        state: executionJobs.state,
        classId: executionJobs.classId,
        attemptId: executionJobs.attemptId,
        questionId: executionJobs.questionId,
        jobSentAt: executionJobs.jobSentAt,
        queuedAt: executionJobs.queuedAt,
      })
      .from(executionJobs)
      .where(
        and(
          forOwnRows(scope, executionJobs),
          eq(executionJobs.reason, 'sample'),
          inArray(executionJobs.state, ['queued', 'running']),
        ),
      );
    const states = await jobStates(
      tx,
      RUN_QUEUE,
      own.map((r) => r.bossJobId),
    );
    const live = own.filter((r) => isLive(r, states.get(r.bossJobId), now));
    // A queued run of the same question gives way, unless a slot has already fetched it: an
    // `active` job runs to its end and keeps counting (P3-12e).
    const superseded = live.filter((r) => {
      const state = states.get(r.bossJobId);
      return (
        r.classId === scope.classId &&
        r.attemptId === attempt.id &&
        r.questionId === question.id &&
        r.state === 'queued' &&
        (state === 'created' || state === 'retry' || state === undefined)
      );
    });
    const active = live.length - superseded.length;
    if (active >= SAMPLE_RUN_CAP) return { capped: active, row: null, cancelled: [] };
    const [row] = await tx
      .insert(executionJobs)
      .values({
        ...fields,
        reason: 'sample',
        limits: built.job.limits,
        priority: PRIORITY.sample,
      })
      .returning();
    if (!row) throw new Error('run insert returned no row');
    // After the insert: `superseded_by` references the new row.
    const cancelled = superseded.length
      ? await tx
          .update(executionJobs)
          .set({ state: 'cancelled', supersededBy: fields.id, finishedAt: now })
          .where(
            and(
              forClass(scope, executionJobs),
              inArray(
                executionJobs.id,
                superseded.map((r) => r.id),
              ),
              eq(executionJobs.state, 'queued'),
            ),
          )
          .returning({ bossJobId: executionJobs.bossJobId })
      : [];
    return { capped: 0, row, cancelled: cancelled.map((c) => c.bossJobId) };
  });
  if (!placed.row) {
    return { ok: false, reason: 'too_many_runs', active: placed.capped, message: CAP_MESSAGE };
  }
  if (placed.cancelled.length > 0) await exec.boss.cancel(RUN_QUEUE, placed.cancelled);
  await sendRun(db, exec, placed.row, now, built.job);
  const row = await rowOf(db, scope, placed.row.id);
  const view = (await viewOf(db, exec, scope, row, now)) as StudentRun;
  return { ok: true, value: { ...view, reused: false } };
}

/** One run of the attempt as the caller may see it; settled first when no longer live. */
export async function readRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  attemptId: string,
  runId: string,
  now: Date,
): Promise<AnyView | undefined> {
  if (!(await attemptFor(db, scope, attemptId))) return undefined;
  const [row] = await db
    .select()
    .from(executionJobs)
    .where(and(visibleRuns(scope, attemptId), eq(executionJobs.id, runId)));
  return row && viewOf(db, deps(), scope, row, now);
}

/** The latest run of a question; for a student their latest sample run. */
export async function latestRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  attemptId: string,
  questionId: string,
  now: Date,
): Promise<Outcome<AnyView | null>> {
  if (!(await attemptFor(db, scope, attemptId))) return notFound;
  const [row] = await db
    .select()
    .from(executionJobs)
    .where(and(visibleRuns(scope, attemptId), eq(executionJobs.questionId, questionId)))
    .orderBy(desc(executionJobs.queuedAt), desc(executionJobs.id))
    .limit(1);
  return { ok: true, value: row ? await viewOf(db, deps(), scope, row, now) : null };
}

/**
 * Cancels the caller's queued sample run (§8.4). A run a slot already runs answers `running`; a
 * settled run is answered as it is.
 */
export async function cancelRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  attemptId: string,
  runId: string,
  now: Date,
): Promise<Outcome<StudentRun> | { ok: false; reason: 'running' }> {
  const [found] = await db
    .select()
    .from(executionJobs)
    .where(and(visibleRuns(scope, attemptId), eq(executionJobs.id, runId)));
  if (found?.reason !== 'sample' || found.userId !== scope.user.id) return notFound;
  const exec = deps();
  const read = await readState(db, queuesOf(exec), found, now);
  if (read.live?.state === 'running') return { ok: false, reason: 'running' };
  if (read.live) {
    const moved = await db
      .update(executionJobs)
      .set({ state: 'cancelled', finishedAt: now })
      .where(
        and(
          forClass(scope, executionJobs),
          eq(executionJobs.id, found.id),
          eq(executionJobs.state, 'queued'),
        ),
      )
      .returning({ id: executionJobs.id });
    if (moved.length > 0) await exec.boss.cancel(RUN_QUEUE, found.bossJobId);
  }
  const row = await rowOf(db, scope, found.id);
  return { ok: true, value: (await viewOf(db, exec, scope, row, now)) as StudentRun };
}

/** The queued rows whose job no slot has fetched: still waiting, or not yet sent (§8.5). */
async function unfetchedOf(ex: Ex, queued: RunRow[], now: Date): Promise<RunRow[]> {
  if (queued.length === 0) return [];
  const states = await jobStates(
    ex,
    RUN_QUEUE,
    queued.map((r) => r.bossJobId),
  );
  return queued.filter((r) => {
    const state = states.get(r.bossJobId);
    return (
      state === 'created' || state === 'retry' || (state === undefined && isLive(r, state, now))
    );
  });
}

/**
 * Cancels the attempt's queued sample runs whose job no slot has fetched (§8.4, P3-12e):
 * submission and expiry end the attempt, so nothing queued for it should still start.
 */
async function cancelQueuedSamples(
  db: Db,
  deps: ExecDeps,
  scope: ClassScope,
  attemptId: string,
  now: Date,
) {
  const queued = await db
    .select()
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        eq(executionJobs.attemptId, attemptId),
        eq(executionJobs.reason, 'sample'),
        eq(executionJobs.state, 'queued'),
      ),
    );
  const unfetched = await unfetchedOf(db, queued, now);
  if (unfetched.length === 0) return;
  const moved = await db
    .update(executionJobs)
    .set({ state: 'cancelled', finishedAt: now })
    .where(
      and(
        forClass(scope, executionJobs),
        inArray(
          executionJobs.id,
          unfetched.map((r) => r.id),
        ),
        eq(executionJobs.state, 'queued'),
      ),
    )
    .returning({ bossJobId: executionJobs.bossJobId });
  if (moved.length > 0) {
    await deps.boss.cancel(
      RUN_QUEUE,
      moved.map((m) => m.bossJobId),
    );
  }
}

/**
 * Inside the transaction that removes `userIds` from the class: their queued sample runs there
 * whose job no slot has fetched become `cancelled` (ADR-0002 "Permission revoked"). Resolves with
 * those runs' pg-boss job ids, which the caller cancels on the runner's queue once the
 * transaction has committed; a job the cancel misses finds its row settled and its result is
 * ignored (§8.5). A run a slot already runs finishes and is recorded as usual.
 */
export async function cancelSamplesOfRemoved(
  tx: Tx,
  scope: ClassManagerScope,
  userIds: string[],
  now: Date,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const queued = await tx
    .select()
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        inArray(executionJobs.userId, userIds),
        eq(executionJobs.reason, 'sample'),
        eq(executionJobs.state, 'queued'),
      ),
    );
  const unfetched = await unfetchedOf(tx, queued, now);
  if (unfetched.length === 0) return [];
  const moved = await tx
    .update(executionJobs)
    .set({ state: 'cancelled', finishedAt: now })
    .where(
      and(
        forClass(scope, executionJobs),
        inArray(
          executionJobs.id,
          unfetched.map((r) => r.id),
        ),
        eq(executionJobs.state, 'queued'),
      ),
    )
    .returning({ id: executionJobs.id, bossJobId: executionJobs.bossJobId });
  if (moved.length > 0) {
    await audit(
      tx,
      moved.map((m) => ({
        actorId: scope.user.id,
        action: 'execution.cancelled',
        scopeKind: 'class' as const,
        scopeId: scope.classId,
        targetType: 'execution_job',
        targetId: m.id,
        after: { reason: 'membership_removed' },
        createdAt: now,
      })),
    );
  }
  return moved.map((m) => m.bossJobId);
}

/** The editable files of a submitted code answer; an unanswered question runs the starter. */
function submittedSnapshot(answers: { questionId: string; value: unknown }[], questionId: string) {
  const value = answers.find((a) => a.questionId === questionId)?.value as
    | { files?: { path: string; content: string }[] }
    | null
    | undefined;
  return { files: (value?.files ?? []).map((f) => ({ path: f.path, content: f.content })) };
}

/**
 * The grading hook (§8.7): one `full` run per code question of a submitted attempt, priority 5,
 * against its pinned revision. Idempotent (one grading row per question, ids fixed on the row),
 * so the submit route, the deadline job and an instructor's read of the results may all call it;
 * a row whose send was never marked is sent again with the same id, which pg-boss drops as a
 * duplicate while the first job exists. It also cancels the attempt's queued sample runs.
 */
export async function enqueueGrading(
  db: Db,
  deps: ExecDeps,
  scope: ClassScope,
  attemptId: string,
  now: Date,
): Promise<void> {
  const attempt = await attemptOf(db, scope, attemptId, 'class');
  if (!attempt || attempt.state === 'in_progress') return;
  await cancelQueuedSamples(db, deps, scope, attempt.id, now);
  const [submission] = await db
    .select()
    .from(testSubmissions)
    .where(and(forClass(scope, testSubmissions), eq(testSubmissions.attemptId, attempt.id)));
  if (!submission) return;
  const [revision] = await db
    .select({ content: resourceRevisions.content })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, attempt.resourceRevisionId));
  const test = testV1.safeParse(revision?.content);
  if (!test.success) return;
  for (const question of test.data.questions) {
    if (question.kind !== 'code') continue;
    const runtime = deps.runtimes.find((r) => r.id === question.runtime);
    const snapshot = submittedSnapshot(submission.answers, question.id);
    const fallback: RunnerRuntime = runtime ?? {
      id: question.runtime,
      language: question.runtime.startsWith('r-') ? 'r' : 'python',
      image: '',
      digest: null,
      harnessVersion: '',
      packages: [],
    };
    const fields = newRow(scope, attempt, question, fallback, snapshot, 'full', now);
    const built = runtime
      ? buildRunnerJob(question, snapshot, 'full', fields.id, runtime)
      : ({ ok: false, message: 'the question’s runtime is not approved' } as const);
    const [row] = await db
      .insert(executionJobs)
      .values({
        ...fields,
        reason: 'grading',
        limits: built.ok ? built.job.limits : { wallSeconds: 1, memoryMiB: 64, outputBytes: 4096 },
        priority: PRIORITY.grading,
      })
      .onConflictDoNothing({
        target: [executionJobs.attemptId, executionJobs.questionId],
        where: sql`${executionJobs.reason} = 'grading'`,
      })
      .returning();
    if (row && !built.ok) {
      await recordFailure(db, row, { kind: 'job_invalid', message: built.message }, now);
    }
  }
  const unsent = await db
    .select()
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        eq(executionJobs.attemptId, attempt.id),
        eq(executionJobs.reason, 'grading'),
        eq(executionJobs.state, 'queued'),
        isNull(executionJobs.jobSentAt),
      ),
    );
  for (const row of unsent) await sendRun(db, deps, row, now);
}

export type ReplayRefusal =
  | { ok: false; reason: 'attempt_open' }
  | { ok: false; reason: 'no_grading_run' }
  | { ok: false; reason: 'no_result' };

/**
 * Instructor replay or regrade of a question's grading (§9). Both run the attempt's pinned
 * revision on the stored snapshot of the latest full run and create new records. A replay keeps
 * the original grader version and pins the image of the latest recorded full result; a run that
 * never produced one (an infrastructure failure, the case NeedsReview asks to replay, §8.7) is
 * replayed on the image its row was sent with: pinned when that is a digest or image id, else the
 * runtime's configured reference, as long as it still yields the original grader version. A
 * regrade runs the runtime's current image with a recomputed grader version.
 */
export async function requestReplay(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  attemptId: string,
  questionId: string,
  input: { reason: 'replay' | 'regrade'; note: string },
  now: Date,
): Promise<Outcome<{ runId: string; state: RunRow['state'] }> | ReplayRefusal> {
  const attempt = await attemptOf(db, scope, attemptId, 'reviewable');
  if (!attempt) return notFound;
  if (attempt.state === 'in_progress') return { ok: false, reason: 'attempt_open' };
  if (scope.archived) return classArchived;
  const full = and(
    forClass(scope, executionJobs),
    eq(executionJobs.attemptId, attempt.id),
    eq(executionJobs.questionId, questionId),
    eq(executionJobs.checkSet, 'full'),
    inArray(executionJobs.reason, ['grading', 'replay', 'regrade']),
  );
  const [original] = await db
    .select()
    .from(executionJobs)
    .where(full)
    .orderBy(desc(executionJobs.queuedAt), desc(executionJobs.id))
    .limit(1);
  if (!original) return { ok: false, reason: 'no_grading_run' };
  const question = await codeQuestionOf(db, original.questionRevisionId, questionId);
  const exec = deps();
  const runtime = exec.runtimes.find((r) => r.id === original.runtimeId);
  if (!question || !runtime) return invalid('This question’s runtime is not available');
  let image: string | undefined;
  if (input.reason === 'replay') {
    const [recorded] = await db
      .select({ imageId: executionResults.imageId, imageDigest: executionResults.imageDigest })
      .from(executionResults)
      .innerJoin(executionJobs, eq(executionJobs.id, executionResults.jobId))
      .where(and(full, forClass(scope, executionResults)))
      .orderBy(desc(executionResults.createdAt))
      .limit(1);
    if (recorded) image = recorded.imageDigest ?? recorded.imageId;
    else if (isPinnable(original.imageRef)) image = original.imageRef;
    else if (
      original.imageRef !== runtimeImage(runtime) ||
      graderVersion(question, runtime) !== original.graderVersion
    ) {
      // The image the failed run was sent with is no longer the runtime's: regrade instead.
      return { ok: false, reason: 'no_result' };
    }
  }
  const fields = newRow(scope, attempt, question, runtime, original.snapshot, 'full', now);
  const built = buildRunnerJob(question, original.snapshot, 'full', fields.id, runtime, image);
  if (!built.ok) return invalid(built.message);
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(executionJobs)
      .values({
        ...fields,
        questionRevisionId: original.questionRevisionId,
        codeHash: original.codeHash,
        reason: input.reason,
        limits: built.job.limits,
        priority: PRIORITY[input.reason],
        ...(input.reason === 'replay' && {
          imageRef: image ?? original.imageRef,
          graderVersion: original.graderVersion,
        }),
        requestedBy: scope.user.id,
        note: input.note || null,
      })
      .returning();
    if (!inserted) throw new Error('replay insert returned no row');
    await audit(tx, {
      actorId: scope.user.id,
      action:
        input.reason === 'replay' ? 'execution.replay_requested' : 'execution.regrade_requested',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'execution_job',
      targetId: inserted.id,
      after: { attemptId: attempt.id, questionId, original: original.id, note: input.note },
      createdAt: now,
    });
    return inserted;
  });
  await sendRun(db, exec, row, now, built.job);
  const fresh = await rowOf(db, scope, row.id);
  return { ok: true, value: { runId: fresh.id, state: fresh.state } };
}

/** Instructor: every run of the attempt with its outcome, each settled first when stale. */
export async function attemptResults(
  db: Db,
  deps: () => ExecDeps | undefined,
  scope: ClassScope,
  attemptId: string,
  now: Date,
): Promise<InstructorRun[] | undefined> {
  const attempt = await attemptOf(db, scope, attemptId, 'reviewable');
  if (!attempt) return undefined;
  const exec = deps();
  // The grading hook again, in case the process that submitted died before it ran.
  if (exec) await enqueueGrading(db, exec, scope, attempt.id, now);
  const rows = await db
    .select()
    .from(executionJobs)
    .where(and(forClass(scope, executionJobs), eq(executionJobs.attemptId, attempt.id)))
    .orderBy(executionJobs.queuedAt, executionJobs.id);
  const runs: InstructorRun[] = [];
  for (const row of rows) {
    if (!exec) {
      runs.push(toInstructorView(row, await resultOf(db, scope, row.id)));
      continue;
    }
    runs.push((await viewOf(db, exec, scope, row, now)) as InstructorRun);
  }
  return runs;
}

/**
 * An instructor preview run (P3-18; design §8.3): the code question of a draft test revision run
 * as the class's preview principal, with no attempt. `scope` is that principal's class scope,
 * `instructorId` the editor who asked. Nothing is reused, superseded or capped (§5): a preview
 * runs against hidden checks the author is still changing, so every request is a fresh run.
 * `files` are editable files to run, the starter files when empty.
 */
export async function requestPreviewRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  input: {
    revisionId: string;
    questionId: string;
    set: CheckSet;
    files: Snapshot['files'];
    instructorId: string;
  },
  now: Date,
): Promise<Outcome<InstructorRun>> {
  if (!scope.membership.isPreview) return notFound;
  const question = await codeQuestionOf(db, input.revisionId, input.questionId);
  if (!question) return notFound;
  if (scope.archived) return classArchived;
  const exec = deps();
  const runtime = exec.runtimes.find((r) => r.id === question.runtime);
  if (!runtime) return invalid('This question’s runtime is not available');
  const snapshot: Snapshot = {
    files: input.files.map((f) => ({ path: f.path, content: f.content })),
  };
  const id = randomUUID();
  const built = buildRunnerJobDetailed(question, snapshot, input.set, id, runtime);
  if (!built.ok) return invalid(built.detail);
  const [inserted] = await db
    .insert(executionJobs)
    .values({
      id,
      bossJobId: randomUUID(),
      classId: scope.classId,
      userId: scope.user.id,
      attemptId: null,
      questionRevisionId: input.revisionId,
      questionId: question.id,
      context: 'preview',
      reason: 'preview',
      checkSet: input.set,
      codeHash: codeHash(snapshot),
      snapshot,
      runtimeId: runtime.id,
      imageRef: runtimeImage(runtime),
      harnessVersion: runtime.harnessVersion,
      graderVersion: graderVersion(question, runtime),
      limits: built.job.limits,
      priority: PRIORITY.preview,
      requestedBy: input.instructorId,
      queuedAt: now,
    })
    .returning();
  if (!inserted) throw new Error('preview run insert returned no row');
  await sendRun(db, exec, inserted, now, built.job);
  const row = await rowOf(db, scope, id);
  return { ok: true, value: (await previewView(db, exec, scope, row, now)) as InstructorRun };
}

/** The instructor view of a preview row, settled first when its job is no longer live. */
async function previewView(db: Db, deps: ExecDeps, scope: ClassScope, row: RunRow, now: Date) {
  const read = await readState(db, queuesOf(deps), row, now);
  const result = read.live ? null : await resultOf(db, scope, row.id);
  return toInstructorView(read.row, result, read.live);
}

/** One preview run of this principal; others' runs and attempt runs are not found. */
export async function readPreviewRun(
  db: Db,
  deps: () => ExecDeps,
  scope: ClassScope,
  runId: string,
  now: Date,
): Promise<InstructorRun | undefined> {
  if (!scope.membership.isPreview) return undefined;
  const [row] = await db
    .select()
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        eq(executionJobs.id, runId),
        eq(executionJobs.context, 'preview'),
        eq(executionJobs.userId, scope.user.id),
      ),
    );
  return row && ((await previewView(db, deps(), scope, row, now)) as InstructorRun);
}
