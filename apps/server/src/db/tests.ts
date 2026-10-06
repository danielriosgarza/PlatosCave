import {
  type AssignmentSettingsPatch,
  mergeSettings,
  settingsProblems,
  type TestV1,
  testV1,
} from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/tests';
import { and, asc, desc, eq, inArray, lte, max, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  answers as answered,
  deadlineFor,
  graderVersionOf,
  type Ineligibility,
  ineligibility,
  isLate,
  type Override,
  parseAnswer,
  questionView,
  termsFor,
  totalPoints,
} from '../assessments/terms';
import type { ClassScope } from '../auth/scope';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
import { audit } from './audit';
import type { Db } from './client';
import { registerAffectedBy } from './content/adoption';
import { studyableResource, type Tx } from './content/releases';
import { excludePreview } from './preview';
import { studentOrRemovedStudent } from './removedStudents';
import {
  assignmentOverrides,
  assignments,
  attemptAnswers,
  auditEvents,
  classMemberships,
  resourceRevisions,
  type SubmittedAnswer,
  testAttempts,
  testSubmissions,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * Assigned tests of one class (§11, §13). Every function takes the resolved `ClassScope`. A
 * student reads and writes only their own attempts; instructors read every real student's. Any
 * read or write of an attempt first settles it: an attempt in progress whose deadline has passed
 * is submitted from its last acknowledged answers, so no caller ever sees it open past its
 * deadline, whether or not the deadline job has run yet. Attempt changes happen under a row lock
 * on the attempt, so a save, a submit and the deadline never interleave.
 */

type Receipt = z.input<typeof contracts.submissionReceipt>;
type Summary = z.input<typeof contracts.attemptSummary>;
type AttemptView = z.input<typeof contracts.attemptView>;
type Overview = z.input<typeof contracts.testOverview>;
type Ack = z.input<typeof contracts.answerAck>;
type SaveAck = z.input<typeof contracts.saveAck>;
type AssignmentView = z.input<typeof contracts.assignmentView>;
type Granted = z.input<typeof contracts.grantedOverride>;
type Reviewed = z.input<typeof contracts.reviewedAttempt>;
type AttemptRow = typeof testAttempts.$inferSelect;
type SubmissionRow = typeof testSubmissions.$inferSelect;
type Ex = Db | Tx;

/** Refusals besides `Outcome`'s: the attempt no longer takes work, or may not start. */
export type Closed = { ok: false; reason: 'closed'; error: ClosedError; receipt: Receipt | null };
type ClosedError = 'attempt_closed' | 'already_submitted';
export type NotEligible = { ok: false; reason: 'not_eligible'; why: Ineligibility };

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The `test.v1` content of a revision; undefined if it is not a valid test. */
async function testOf(ex: Ex, revisionId: string): Promise<TestV1 | undefined> {
  const [row] = await ex
    .select({ content: resourceRevisions.content, type: resourceRevisions.type })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  if (row?.type !== 'test') return undefined;
  const parsed = testV1.safeParse(row.content);
  return parsed.success ? parsed.data : undefined;
}

export async function pinnedTest(ex: Ex, attempt: AttemptRow): Promise<TestV1> {
  const test = await testOf(ex, attempt.resourceRevisionId);
  if (!test) throw new Error(`attempt ${attempt.id} references an invalid test`);
  return test;
}

const invalidTest = invalid('This test cannot be opened: its definition is not valid');

/** The class's assignment row for a test, if its settings were ever saved or an attempt made. */
export async function assignmentOf(ex: Ex, scope: ClassScope, resourceId: string) {
  const [row] = await ex
    .select()
    .from(assignments)
    .where(and(forClass(scope, assignments), eq(assignments.resourceId, resourceId)));
  return row;
}

async function ensureAssignment(tx: Tx, scope: ClassScope, resourceId: string) {
  await tx.insert(assignments).values({ classId: scope.classId, resourceId }).onConflictDoNothing();
  const row = await assignmentOf(tx, scope, resourceId);
  if (!row) throw new Error('assignment insert returned no row');
  return row;
}

/** The override in force for one student: the latest grant. */
async function overrideOf(
  ex: Ex,
  scope: ClassScope,
  assignmentId: string | undefined,
  userId: string,
): Promise<Override | null> {
  if (!assignmentId) return null;
  const [row] = await ex
    .select()
    .from(assignmentOverrides)
    .where(
      and(
        forClass(scope, assignmentOverrides),
        eq(assignmentOverrides.assignmentId, assignmentId),
        eq(assignmentOverrides.userId, userId),
      ),
    )
    .orderBy(desc(assignmentOverrides.createdAt), desc(assignmentOverrides.id))
    .limit(1);
  return row
    ? {
        extraAttempts: row.extraAttempts,
        extraMinutes: row.extraMinutes,
        closesAt: iso(row.closesAt),
      }
    : null;
}

export const settingsOf = (test: TestV1, patch: AssignmentSettingsPatch | undefined) =>
  mergeSettings(test.settings, patch);

async function termsOfAttempt(ex: Ex, scope: ClassScope, attempt: AttemptRow, test: TestV1) {
  const override = await overrideOf(ex, scope, attempt.assignmentId, attempt.userId);
  return termsFor(attempt.settings, override, totalPoints(test));
}

const answerRows = (ex: Ex, scope: ClassScope, attemptId: string) =>
  ex
    .select()
    .from(attemptAnswers)
    .where(and(forClass(scope, attemptAnswers), eq(attemptAnswers.attemptId, attemptId)))
    .orderBy(asc(attemptAnswers.questionId));

function receiptOf(row: SubmissionRow, test: TestV1): Receipt {
  const given = row.answers.filter((a) => answered(a.value));
  const ids = new Set(given.map((a) => a.questionId));
  return {
    submissionId: row.id,
    attemptId: row.attemptId,
    submittedAt: row.submittedAt.toISOString(),
    autoSubmitted: row.autoSubmitted,
    late: row.late,
    answers: given.map(({ questionId, seq, savedAt }) => ({ questionId, seq, savedAt })),
    unanswered: test.questions.filter((q) => !ids.has(q.id)).map((q) => q.id),
  };
}

export async function submissionOf(ex: Ex, scope: ClassScope, attemptId: string) {
  const [row] = await ex
    .select()
    .from(testSubmissions)
    .where(and(forClass(scope, testSubmissions), eq(testSubmissions.attemptId, attemptId)));
  return row;
}

/**
 * Freezes the attempt's acknowledged answers as its submission and closes the attempt. The
 * caller holds the attempt's row lock.
 */
async function freeze(
  tx: Tx,
  scope: ClassScope,
  attempt: AttemptRow,
  test: TestV1,
  how: { key: string | null; at: Date },
) {
  const terms = await termsOfAttempt(tx, scope, attempt, test);
  const frozen: SubmittedAnswer[] = (await answerRows(tx, scope, attempt.id)).map((a) => ({
    questionId: a.questionId,
    value: a.value,
    flagged: a.flagged,
    seq: a.seq,
    savedAt: a.savedAt.toISOString(),
  }));
  const [row] = await tx
    .insert(testSubmissions)
    .values({
      classId: scope.classId,
      attemptId: attempt.id,
      userId: attempt.userId,
      submissionKey: how.key,
      answers: frozen,
      autoSubmitted: how.key === null,
      late: isLate(terms, how.at),
      submittedAt: how.at,
    })
    .returning();
  if (!row) throw new Error('submission insert returned no row');
  const [closed] = await tx
    .update(testAttempts)
    .set({ state: 'submitted', submittedAt: how.at })
    .where(and(forClass(scope, testAttempts), eq(testAttempts.id, attempt.id)))
    .returning();
  if (!closed) throw new Error('attempt update returned no row');
  if (!attempt.isPreview) {
    await audit(tx, {
      actorId: how.key === null ? null : scope.user.id,
      action: how.key === null ? 'test.auto_submitted' : 'test.submitted',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'test_submission',
      targetId: row.id,
      after: { attemptId: attempt.id, answers: frozen.length, late: row.late },
      createdAt: how.at,
    });
  }
  return { attempt: closed, submission: row };
}

/** Submits an attempt whose deadline has passed; the caller holds its row lock. */
async function settle(tx: Tx, scope: ClassScope, attempt: AttemptRow, now: Date) {
  if (attempt.state !== 'in_progress' || !attempt.deadlineAt || attempt.deadlineAt > now) {
    return attempt;
  }
  const test = await pinnedTest(tx, attempt);
  return (await freeze(tx, scope, attempt, test, { key: null, at: attempt.deadlineAt })).attempt;
}

const own = (scope: ClassScope) =>
  and(forClass(scope, testAttempts), eq(testAttempts.userId, scope.user.id));

/** Locks and settles one attempt; `mine` limits it to the caller's own. */
async function lockAttempt(tx: Tx, scope: ClassScope, attemptId: string, now: Date, mine = true) {
  const [row] = await tx
    .select()
    .from(testAttempts)
    .where(and(mine ? own(scope) : forClass(scope, testAttempts), eq(testAttempts.id, attemptId)))
    .for('update');
  return row && settle(tx, scope, row, now);
}

const RECOVERY_REQUESTED = 'test_attempt.recovery_requested';

/** When an instructor last asked for the attempt's unsent local work (an audit event; no table of its own). */
async function recoveryRequestedAt(ex: Ex, scope: ClassScope, attemptId: string) {
  const [row] = await ex
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, RECOVERY_REQUESTED),
        eq(auditEvents.scopeKind, 'class'),
        eq(auditEvents.scopeId, scope.classId),
        eq(auditEvents.targetId, attemptId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  return iso(row?.createdAt ?? null);
}

async function summaryOf(ex: Ex, scope: ClassScope, attempt: AttemptRow, test: TestV1) {
  const submission =
    attempt.state === 'in_progress' ? undefined : await submissionOf(ex, scope, attempt.id);
  return {
    id: attempt.id,
    number: attempt.number,
    state: attempt.state,
    resourceRevisionId: attempt.resourceRevisionId,
    startedAt: attempt.startedAt.toISOString(),
    deadlineAt: iso(attempt.deadlineAt),
    submittedAt: iso(attempt.submittedAt),
    receipt: submission ? receiptOf(submission, test) : null,
    localCopyAt: iso(attempt.localCopyAt),
    recoveryRequestedAt: await recoveryRequestedAt(ex, scope, attempt.id),
  } satisfies Summary;
}

async function viewOf(ex: Ex, scope: ClassScope, attempt: AttemptRow, now: Date) {
  const test = await pinnedTest(ex, attempt);
  const submission =
    attempt.state === 'in_progress' ? undefined : await submissionOf(ex, scope, attempt.id);
  const saved = submission
    ? submission.answers
    : (await answerRows(ex, scope, attempt.id)).map((a) => ({
        ...a,
        savedAt: a.savedAt.toISOString(),
      }));
  return {
    ...(await summaryOf(ex, scope, attempt, test)),
    graderVersion: attempt.graderVersion,
    terms: await termsOfAttempt(ex, scope, attempt, test),
    questions: test.questions.map(questionView),
    answers: saved.map((a) => ({
      questionId: a.questionId,
      seq: a.seq,
      savedAt: a.savedAt,
      value: a.value,
      flagged: a.flagged,
    })),
    serverNow: now.toISOString(),
  } satisfies AttemptView;
}

/** Settles the caller's attempts of a test that are past their deadline. */
async function settleOwn(db: Db, scope: ClassScope, resourceId: string, now: Date) {
  const due = await db
    .select({ id: testAttempts.id })
    .from(testAttempts)
    .where(
      and(
        own(scope),
        eq(testAttempts.resourceId, resourceId),
        eq(testAttempts.state, 'in_progress'),
        lte(testAttempts.deadlineAt, now),
      ),
    );
  for (const { id } of due) await db.transaction((tx) => lockAttempt(tx, scope, id, now));
}

const ownAttemptsOf = (ex: Ex, scope: ClassScope, resourceId: string) =>
  ex
    .select()
    .from(testAttempts)
    .where(and(own(scope), eq(testAttempts.resourceId, resourceId)))
    .orderBy(desc(testAttempts.number));

/** A test of the class's release the caller may study now, and its valid definition. */
export async function studyableTest(ex: Ex, scope: ClassScope, resourceId: string, now: Date) {
  const resource = await studyableResource(ex, scope, resourceId, now);
  if (resource?.type !== 'test') return notFound;
  const test = await testOf(ex, resource.revisionId);
  if (!test) return invalidTest;
  return { ok: true as const, revisionId: resource.revisionId, test };
}

/** Terms, the caller's attempts and whether they may start one now. Inserts nothing. */
export async function readTest(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<Overview>> {
  const found = await studyableTest(db, scope, resourceId, now);
  if (!found.ok) return found;
  await settleOwn(db, scope, resourceId, now);
  const assignment = await assignmentOf(db, scope, resourceId);
  const override = await overrideOf(db, scope, assignment?.id, scope.user.id);
  const terms = termsFor(
    settingsOf(found.test, assignment?.settings),
    override,
    totalPoints(found.test),
  );
  const rows = await ownAttemptsOf(db, scope, resourceId);
  const attempts = [];
  for (const row of rows) attempts.push(await summaryOf(db, scope, row, await pinnedTest(db, row)));
  const why = scope.archived ? 'class_archived' : ineligibility(terms, rows, now);
  return {
    ok: true,
    value: {
      resourceId,
      resourceRevisionId: found.revisionId,
      terms,
      questionCount: found.test.questions.length,
      attempts,
      eligibility: {
        canStart: why === null,
        reason: why,
        attemptsUsed: rows.length,
        attemptsAllowed: terms.attempts,
      },
      serverNow: now.toISOString(),
    },
  };
}

/**
 * Resumes the caller's attempt in progress, or starts the next one on the class's current
 * revision after checking eligibility (§11). `started` is true when an attempt was created.
 */
export async function startAttempt(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<AttemptView & { started: boolean }> | NotEligible> {
  const found = await studyableTest(db, scope, resourceId, now);
  if (!found.ok) return found;
  const { test, revisionId } = found;
  return db.transaction(async (tx) => {
    // One student's starts of one test are serialised, so two clicks start one attempt.
    const lock = `test-attempt:${scope.classId}:${scope.user.id}:${resourceId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const rows = [];
    for (const row of await ownAttemptsOf(tx, scope, resourceId)) {
      const settled = await lockAttempt(tx, scope, row.id, now);
      if (settled) rows.push(settled);
    }
    const open = rows.find((r) => r.state === 'in_progress');
    if (open)
      return { ok: true, value: { ...(await viewOf(tx, scope, open, now)), started: false } };
    if (scope.archived) return classArchived;
    const assignment = await ensureAssignment(tx, scope, resourceId);
    const settings = settingsOf(test, assignment.settings);
    const problems = settingsProblems(settings);
    if (problems.length > 0) return invalid(`This test’s terms cannot be applied: ${problems[0]}`);
    const override = await overrideOf(tx, scope, assignment.id, scope.user.id);
    const terms = termsFor(settings, override, totalPoints(test));
    const why = ineligibility(terms, rows, now);
    if (why) return { ok: false, reason: 'not_eligible', why };
    const [last] = await tx
      .select({ number: max(testAttempts.number) })
      .from(testAttempts)
      .where(and(own(scope), eq(testAttempts.resourceId, resourceId)));
    const [row] = await tx
      .insert(testAttempts)
      .values({
        classId: scope.classId,
        assignmentId: assignment.id,
        userId: scope.user.id,
        isPreview: scope.membership.isPreview,
        resourceId,
        resourceRevisionId: revisionId,
        graderVersion: graderVersionOf(test),
        number: (last?.number ?? 0) + 1,
        settings,
        startedAt: now,
        deadlineAt: deadlineFor(terms, now),
      })
      .returning();
    if (!row) throw new Error('attempt insert returned no row');
    return { ok: true, value: { ...(await viewOf(tx, scope, row, now)), started: true } };
  });
}

/** The caller's attempt as the server holds it, settled first (reconnect, §11). */
export async function readAttempt(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  now: Date,
): Promise<AttemptView | undefined> {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, scope, attemptId, now);
    return attempt && viewOf(tx, scope, attempt, now);
  });
}

async function closedWith(ex: Ex, scope: ClassScope, attempt: AttemptRow): Promise<Closed> {
  const submission = await submissionOf(ex, scope, attempt.id);
  return {
    ok: false,
    reason: 'closed',
    error: submission?.autoSubmitted === false ? 'already_submitted' : 'attempt_closed',
    receipt: submission ? receiptOf(submission, await pinnedTest(ex, attempt)) : null,
  };
}

/**
 * Autosave: stores one answer of the caller's attempt in progress and acknowledges it. A save
 * whose `seq` is not above the stored one changes nothing and answers the stored acknowledgement
 * with `applied: false`, so the client never takes another write's acknowledgement for its own.
 */
export async function saveAnswer(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  questionId: string,
  input: { value: unknown; flagged: boolean; seq: number },
  now: Date,
): Promise<Outcome<SaveAck> | Closed> {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, scope, attemptId, now);
    if (!attempt) return notFound;
    if (attempt.state !== 'in_progress') return closedWith(tx, scope, attempt);
    if (scope.archived) return classArchived;
    const question = (await pinnedTest(tx, attempt)).questions.find((q) => q.id === questionId);
    if (!question) return invalid('This test has no such question');
    const parsed = parseAnswer(question, input.value);
    if (!parsed.ok) return invalid(parsed.message);
    const [saved] = await tx
      .insert(attemptAnswers)
      .values({
        classId: scope.classId,
        attemptId,
        questionId,
        value: parsed.value,
        flagged: input.flagged,
        seq: input.seq,
        savedAt: now,
      })
      .onConflictDoUpdate({
        target: [attemptAnswers.attemptId, attemptAnswers.questionId],
        set: { value: parsed.value, flagged: input.flagged, seq: input.seq, savedAt: now },
        setWhere: sql`${attemptAnswers.seq} < excluded.seq`,
      })
      .returning();
    const row =
      saved ?? (await answerRows(tx, scope, attemptId)).find((a) => a.questionId === questionId);
    if (!row) throw new Error('answer upsert returned no row');
    return {
      ok: true,
      value: {
        questionId,
        seq: row.seq,
        savedAt: row.savedAt.toISOString(),
        applied: saved !== undefined,
      },
    };
  });
}

/**
 * Submit test: freezes the attempt (§11). The same key answers the same receipt, so a double
 * click or a retry after a dropped response makes one submission (A14).
 */
export async function submitAttempt(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  submissionKey: string,
  now: Date,
): Promise<Outcome<Receipt> | Closed> {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, scope, attemptId, now);
    if (!attempt) return notFound;
    if (attempt.state !== 'in_progress') {
      const submission = await submissionOf(tx, scope, attempt.id);
      if (submission?.submissionKey === submissionKey) {
        return { ok: true, value: receiptOf(submission, await pinnedTest(tx, attempt)) };
      }
      return closedWith(tx, scope, attempt);
    }
    if (scope.archived) return classArchived;
    const [reused] = await tx
      .select({ id: testSubmissions.id })
      .from(testSubmissions)
      .where(
        and(
          forClass(scope, testSubmissions),
          eq(testSubmissions.userId, scope.user.id),
          eq(testSubmissions.submissionKey, submissionKey),
        ),
      );
    if (reused) return invalid('This submission key was already used for another attempt');
    const test = await pinnedTest(tx, attempt);
    const { submission } = await freeze(tx, scope, attempt, test, { key: submissionKey, at: now });
    return { ok: true, value: receiptOf(submission, test) };
  });
}

/**
 * Keeps the work the browser still held when the attempt closed, for an instructor recovery
 * request (§11, A15). The submission and its receipt are unchanged.
 */
export async function keepLocalCopy(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  copy: { questionId: string; value?: unknown }[],
  now: Date,
): Promise<Outcome<{ localCopyAt: string }> | { ok: false; reason: 'attempt_open' }> {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, scope, attemptId, now);
    if (!attempt) return notFound;
    if (attempt.state === 'in_progress') return { ok: false, reason: 'attempt_open' };
    if (scope.archived) return classArchived;
    const ids = new Set((await pinnedTest(tx, attempt)).questions.map((q) => q.id));
    if (!copy.every((a) => ids.has(a.questionId))) return invalid('This test has no such question');
    await tx
      .update(testAttempts)
      .set({
        localCopy: {
          answers: copy.map((a) => ({ questionId: a.questionId, value: a.value ?? null })),
        },
        localCopyAt: now,
      })
      .where(and(own(scope), eq(testAttempts.id, attemptId)));
    return { ok: true, value: { localCopyAt: now.toISOString() } };
  });
}

/**
 * Instructor: asks the student for the unsent local work of a closed attempt, with a reason
 * (§11, A15). Recorded as an audit event; the attempt and its receipt are unchanged.
 */
export async function requestRecovery(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  reason: string,
  now: Date,
): Promise<Outcome<{ requestedAt: string }> | { ok: false; reason: 'attempt_open' }> {
  return db.transaction(async (tx) => {
    const found = await lockReviewable(tx, scope, attemptId, now);
    if (!found) return notFound;
    if (found.attempt.state === 'in_progress') return { ok: false, reason: 'attempt_open' };
    if (scope.archived) return classArchived;
    await audit(tx, {
      actorId: scope.user.id,
      action: RECOVERY_REQUESTED,
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'test_attempt',
      targetId: attemptId,
      after: { reason, studentId: found.student.id },
      createdAt: now,
    });
    return { ok: true, value: { requestedAt: now.toISOString() } };
  });
}

/**
 * The deadline job (`tests.expire-attempt`): settles one attempt of the class. Returns its
 * deadline while it is still open, so the job can run again then (an extension moved it).
 */
export async function expireAttempt(db: Db, scope: ClassScope, attemptId: string, now: Date) {
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, scope, attemptId, now, false);
    if (!attempt) return { state: 'missing' as const, deadlineAt: null };
    return {
      state: attempt.state,
      deadlineAt: attempt.state === 'in_progress' ? attempt.deadlineAt : null,
    };
  });
}

async function grantedOf(ex: Ex, scope: ClassScope, assignmentId: string): Promise<Granted[]> {
  const rows = await ex
    .selectDistinctOn([assignmentOverrides.userId], {
      override: assignmentOverrides,
      name: users.name,
    })
    .from(assignmentOverrides)
    .innerJoin(users, eq(users.id, assignmentOverrides.userId))
    .where(
      and(forClass(scope, assignmentOverrides), eq(assignmentOverrides.assignmentId, assignmentId)),
    )
    .orderBy(
      assignmentOverrides.userId,
      desc(assignmentOverrides.createdAt),
      desc(assignmentOverrides.id),
    );
  return rows.map(({ override: o, name }) => ({
    id: o.id,
    student: { id: o.userId, name },
    extraAttempts: o.extraAttempts,
    extraMinutes: o.extraMinutes,
    closesAt: iso(o.closesAt),
    reason: o.reason,
    grantedBy: o.grantedBy,
    createdAt: o.createdAt.toISOString(),
  }));
}

async function assignmentViewOf(
  ex: Ex,
  scope: ClassScope,
  resourceId: string,
  test: TestV1,
): Promise<AssignmentView> {
  const row = await assignmentOf(ex, scope, resourceId);
  return {
    resourceId,
    settings: row?.settings ?? {},
    effective: settingsOf(test, row?.settings),
    revision: row?.updatedBy ? row.revision : null,
    overrides: row ? await grantedOf(ex, scope, row.id) : [],
  };
}

/** Instructor: the class's terms for a test and the overrides in force. */
export async function readAssignment(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<AssignmentView>> {
  const found = await studyableTest(db, scope, resourceId, now);
  if (!found.ok) return found;
  return { ok: true, value: await assignmentViewOf(db, scope, resourceId, found.test) };
}

/**
 * Instructor: sets the class's terms for a test, checked against the revision it was based on.
 * Attempts already started keep the terms they started with.
 */
export async function updateAssignment(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: { settings: AssignmentSettingsPatch; expectedRevision: number | null },
  now: Date,
): Promise<Outcome<AssignmentView>> {
  const found = await studyableTest(db, scope, resourceId, now);
  if (!found.ok) return found;
  if (scope.archived) return classArchived;
  const problems = settingsProblems(settingsOf(found.test, input.settings));
  if (problems.length > 0) return invalid(`These terms cannot be applied: ${problems[0]}`);
  return db.transaction(async (tx) => {
    await ensureAssignment(tx, scope, resourceId);
    const [row] = await tx
      .select()
      .from(assignments)
      .where(and(forClass(scope, assignments), eq(assignments.resourceId, resourceId)))
      .for('update');
    if (!row) throw new Error('assignment vanished');
    // A row only an attempt created has never been saved: its revision is still 1 and unseen.
    const saved = row.updatedBy !== null;
    const expected = saved ? row.revision : null;
    if (input.expectedRevision !== expected) {
      return {
        ok: false,
        reason: 'conflict',
        current: await assignmentViewOf(tx, scope, resourceId, found.test),
      };
    }
    await tx
      .update(assignments)
      .set({
        settings: input.settings,
        revision: saved ? row.revision + 1 : 1,
        updatedBy: scope.user.id,
        updatedAt: now,
      })
      .where(and(forClass(scope, assignments), eq(assignments.id, row.id)));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'assignment.updated',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'assignment',
      targetId: row.id,
      before: row.settings,
      after: input.settings,
      createdAt: now,
    });
    return { ok: true, value: await assignmentViewOf(tx, scope, resourceId, found.test) };
  });
}

/**
 * Instructor: grants a student of the class an extension or extra attempts (§11). The deadline
 * of their attempt in progress is recomputed; `open` names it so the caller can schedule the
 * deadline job.
 */
export async function grantOverride(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: Override & { studentId: string; reason: string },
  now: Date,
): Promise<Outcome<Granted & { open: { attemptId: string; deadlineAt: Date | null } | null }>> {
  const found = await studyableTest(db, scope, resourceId, now);
  if (!found.ok) return found;
  if (scope.archived) return classArchived;
  return db.transaction(async (tx) => {
    const [student] = await tx
      .select({ name: users.name })
      .from(classMemberships)
      .innerJoin(users, eq(users.id, classMemberships.userId))
      .where(
        and(
          forClass(scope, classMemberships),
          eq(classMemberships.userId, input.studentId),
          eq(classMemberships.role, 'student'),
          excludePreview(classMemberships),
        ),
      );
    if (!student) return invalid('Only a student of this class can be granted an override');
    const assignment = await ensureAssignment(tx, scope, resourceId);
    const [row] = await tx
      .insert(assignmentOverrides)
      .values({
        classId: scope.classId,
        assignmentId: assignment.id,
        userId: input.studentId,
        extraAttempts: input.extraAttempts,
        extraMinutes: input.extraMinutes,
        closesAt: input.closesAt === null ? null : new Date(input.closesAt),
        reason: input.reason,
        grantedBy: scope.user.id,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('override insert returned no row');
    await audit(tx, {
      actorId: scope.user.id,
      action: 'assignment.override_granted',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'assignment_override',
      targetId: row.id,
      after: {
        studentId: input.studentId,
        extraAttempts: input.extraAttempts,
        extraMinutes: input.extraMinutes,
        closesAt: input.closesAt,
        reason: input.reason,
      },
      createdAt: now,
    });
    let open: { attemptId: string; deadlineAt: Date | null } | null = null;
    const [attempt] = await tx
      .select()
      .from(testAttempts)
      .where(
        and(
          forClass(scope, testAttempts),
          eq(testAttempts.userId, input.studentId),
          eq(testAttempts.resourceId, resourceId),
          eq(testAttempts.state, 'in_progress'),
        ),
      )
      .for('update');
    if (attempt) {
      const terms = await termsOfAttempt(tx, scope, attempt, await pinnedTest(tx, attempt));
      const deadlineAt = deadlineFor(terms, attempt.startedAt);
      await tx
        .update(testAttempts)
        .set({ deadlineAt })
        .where(and(forClass(scope, testAttempts), eq(testAttempts.id, attempt.id)));
      open = { attemptId: attempt.id, deadlineAt };
    }
    const granted = (await grantedOf(tx, scope, assignment.id)).find(
      (g) => g.student.id === input.studentId,
    );
    if (!granted) throw new Error('granted override not found');
    return { ok: true, value: { ...granted, open } };
  });
}

/**
 * Real students' attempts of the class, removed students included; preview rows never. Needs
 * `classMemberships` left-joined on class and user (`studentOrRemovedStudent`).
 */
export const reviewable = (scope: ClassScope) =>
  and(
    forClass(scope, testAttempts),
    excludePreview(testAttempts),
    studentOrRemovedStudent(testAttempts),
  );

async function settleDue(db: Db, scope: ClassScope, where: ReturnType<typeof and>, now: Date) {
  const due = await db
    .select({ id: testAttempts.id })
    .from(testAttempts)
    .where(and(where, eq(testAttempts.state, 'in_progress'), lte(testAttempts.deadlineAt, now)));
  for (const { id } of due) await db.transaction((tx) => lockAttempt(tx, scope, id, now, false));
}

/** Submits every overdue in-progress attempt of the class, as the review reads do. */
export const settleClassDue = (db: Db, scope: ClassScope, now: Date) =>
  settleDue(db, scope, forClass(scope, testAttempts), now);

async function reviewedOf(db: Db, scope: ClassScope, where: ReturnType<typeof and>) {
  const rows = await db
    .select({ attempt: testAttempts, name: users.name, role: classMemberships.role })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(and(reviewable(scope), where))
    .orderBy(asc(users.name), asc(testAttempts.userId), desc(testAttempts.number));
  const reviewed: (Reviewed & { row: AttemptRow; test: TestV1 })[] = [];
  for (const { attempt, name, role } of rows) {
    const test = await pinnedTest(db, attempt);
    reviewed.push({
      ...(await summaryOf(db, scope, attempt, test)),
      student: { id: attempt.userId, name },
      removed: role === null,
      graderVersion: attempt.graderVersion,
      row: attempt,
      test,
    });
  }
  return reviewed;
}

/**
 * An attempt of a real student of the class (removed students included), locked and settled,
 * for grading (P4-01); undefined for a preview or instructor attempt or another class's.
 */
export async function lockReviewable(tx: Tx, scope: ClassScope, attemptId: string, now: Date) {
  const attempt = await lockAttempt(tx, scope, attemptId, now, false);
  if (!attempt) return undefined;
  const [found] = await tx
    .select({ name: users.name, role: classMemberships.role })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(and(reviewable(scope), eq(testAttempts.id, attemptId)));
  return found && { attempt, student: { id: attempt.userId, name: found.name } };
}

/** Real students' attempts of a test, settled first, without their summaries (P4-01). */
export async function reviewableAttempts(db: Db, scope: ClassScope, resourceId: string, now: Date) {
  const ofTest = eq(testAttempts.resourceId, resourceId);
  await settleDue(db, scope, and(forClass(scope, testAttempts), ofTest), now);
  const rows = await db
    .select({ attempt: testAttempts, name: users.name, role: classMemberships.role })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(and(reviewable(scope), ofTest))
    .orderBy(asc(users.name), asc(testAttempts.userId), desc(testAttempts.number));
  return rows.map((r) => ({ attempt: r.attempt, name: r.name, removed: r.role === null }));
}

/** The caller's own attempts of a test, settled first, newest first (P4-01). */
export async function ownAttempts(db: Db, scope: ClassScope, resourceId: string, now: Date) {
  await settleOwn(db, scope, resourceId, now);
  return ownAttemptsOf(db, scope, resourceId);
}

/** Instructor: every real student's attempts of a test in this class. */
export async function reviewAttempts(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Reviewed[]> {
  const ofTest = eq(testAttempts.resourceId, resourceId);
  await settleDue(db, scope, and(forClass(scope, testAttempts), ofTest), now);
  return (await reviewedOf(db, scope, ofTest)).map(({ row: _row, test: _test, ...r }) => r);
}

/** Instructor: one attempt with the revision it was taken on, its answers and local copy. */
export async function reviewAttempt(db: Db, scope: ClassScope, attemptId: string, now: Date) {
  const byId = eq(testAttempts.id, attemptId);
  await settleDue(db, scope, and(forClass(scope, testAttempts), byId), now);
  const [found] = await reviewedOf(db, scope, byId);
  if (!found) return undefined;
  const { row, test, ...reviewed } = found;
  const [raw] = await db
    .select({ content: resourceRevisions.content })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, row.resourceRevisionId));
  const view = await viewOf(db, scope, row, now);
  const copy = row.localCopy as { answers?: { questionId: string; value: unknown }[] } | null;
  return {
    ...reviewed,
    terms: await termsOfAttempt(db, scope, row, test),
    test: raw?.content ?? {},
    answers: view.answers,
    localCopy: copy?.answers ?? null,
  };
}

/** Whether the caller submitted a test in this class (topic completion, P2-16). */
export async function submittedTests(db: Db, classId: string, userId: string) {
  const rows = await db
    .selectDistinct({ resourceId: testAttempts.resourceId })
    .from(testAttempts)
    .where(
      and(
        eq(testAttempts.classId, classId),
        eq(testAttempts.userId, userId),
        ne(testAttempts.state, 'in_progress'),
      ),
    );
  return rows.map((r) => r.resourceId);
}

/**
 * Adoption diff (ADR-0003, §12): how many real students' attempts are pinned to each revision
 * the class stops using; those attempts keep their revision (A16).
 */
registerAffectedBy('assignments', async (ex, scope, revisionIds) => {
  const rows = await ex
    .select({ revisionId: testAttempts.resourceRevisionId, n: sql<number>`count(*)` })
    .from(testAttempts)
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(and(reviewable(scope), inArray(testAttempts.resourceRevisionId, revisionIds)))
    .groupBy(testAttempts.resourceRevisionId);
  return new Map(rows.map((r) => [r.revisionId, Number(r.n)]));
});
