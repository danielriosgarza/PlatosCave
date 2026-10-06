import type * as contracts from '@parallax/contracts/routes/grades';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import {
  type CodeResult,
  feedbackProblem,
  markOf,
  type ReportRule,
  reportedOf,
  scoreAttempt,
} from '../assessments/grading';
import type { ClassScope } from '../auth/scope';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
import { audit } from './audit';
import type { Db, Tx } from './client';
import {
  classMemberships,
  executionJobs,
  executionResults,
  gradeOverrides,
  gradeReleases,
  grades,
  testAttempts,
  users,
} from './schema';
import { forClass } from './scoped';
import {
  assignmentOf,
  lockReviewable,
  ownAttempts,
  pinnedTest,
  reviewable,
  reviewableAttempts,
  settingsOf,
  studyableTest,
  submissionOf,
} from './tests';

/**
 * Grades of test attempts (§11, §12). Every function takes the resolved `ClassScope`; only real
 * students' attempts are graded (preview and instructor attempts are not found), and students
 * read only released rows of their own attempts. Grade changes run under the attempt's row lock
 * and name the row they are based on, so two instructors never overwrite each other silently.
 */

export type AttemptGrade = z.input<typeof contracts.attemptGrade>;
type GradeView = z.input<typeof contracts.gradeView>;
type Preview = z.input<typeof contracts.releasePreview>;
type Release = z.input<typeof contracts.gradeRelease>;
type TestGrades = z.input<(typeof contracts.readTestGrades)['response']>;
type MyResults = z.input<(typeof contracts.readMyResults)['response']>;
type GradeRow = typeof grades.$inferSelect;
type OverrideRow = typeof gradeOverrides.$inferSelect;
type AttemptRow = typeof testAttempts.$inferSelect;
type Ex = Db | Tx;

export type AttemptOpen = { ok: false; reason: 'attempt_open' };
export type ReleaseChanged = { ok: false; reason: 'release_changed'; preview: Preview };

const iso = (d: Date | null) => d?.toISOString() ?? null;

async function answersOf(ex: Ex, scope: ClassScope, attemptId: string) {
  const submission = await submissionOf(ex, scope, attemptId);
  return new Map((submission?.answers ?? []).map((a) => [a.questionId, a.value]));
}

/**
 * Each code question's latest full-run result (grading, replay or regrade); without one, whether
 * its latest full run is still queued or running (`pending`) or ended without a result.
 */
async function codeResultsOf(ex: Ex, scope: ClassScope, attemptId: string) {
  const results = await ex
    .select({
      id: executionResults.id,
      questionId: executionResults.questionId,
      status: executionResults.status,
      outcome: executionResults.outcome,
    })
    .from(executionResults)
    .where(
      and(
        forClass(scope, executionResults),
        eq(executionResults.attemptId, attemptId),
        eq(executionResults.checkSet, 'full'),
      ),
    )
    .orderBy(desc(executionResults.createdAt), desc(executionResults.id));
  const jobs = await ex
    .select({ questionId: executionJobs.questionId, state: executionJobs.state })
    .from(executionJobs)
    .where(
      and(
        forClass(scope, executionJobs),
        eq(executionJobs.attemptId, attemptId),
        eq(executionJobs.checkSet, 'full'),
      ),
    )
    .orderBy(desc(executionJobs.queuedAt), desc(executionJobs.id));
  const code = new Map<string, CodeResult>();
  for (const r of results) {
    if (code.has(r.questionId)) continue;
    const checks = (r.outcome as { result?: { checks?: { name: string; status: string }[] } })
      .result?.checks;
    code.set(r.questionId, {
      status: 'scored',
      resultId: r.id,
      outcomeStatus: r.status,
      checks: checks ?? [],
    });
  }
  for (const j of jobs) {
    if (code.has(j.questionId)) continue;
    const live = j.state === 'queued' || j.state === 'running';
    code.set(j.questionId, { status: live ? 'pending' : 'unavailable' });
  }
  return code;
}

function gradeViewOf(row: GradeRow, override: OverrideRow | undefined): GradeView {
  return {
    id: row.id,
    attemptId: row.attemptId,
    number: row.number,
    state: row.state,
    source: row.source,
    reason: row.reason,
    resourceRevisionId: row.resourceRevisionId,
    graderVersion: row.graderVersion,
    questions: row.questions,
    feedback: row.feedback,
    automatedPoints: row.automatedPoints,
    manualPoints: row.manualPoints,
    override: override
      ? {
          id: override.id,
          points: override.points,
          reason: override.reason,
          priorGradeId: override.priorGradeId,
          createdBy: override.createdBy,
          createdAt: override.createdAt.toISOString(),
        }
      : null,
    points: row.points,
    possible: row.possible,
    complete: row.complete,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    releaseId: row.releaseId,
    releasedAt: iso(row.releasedAt),
  };
}

const gradesOf = (ex: Ex, scope: ClassScope, attemptId: string) =>
  ex
    .select()
    .from(grades)
    .where(and(forClass(scope, grades), eq(grades.attemptId, attemptId)))
    .orderBy(desc(grades.number));

async function attemptGradeOf(
  ex: Ex,
  scope: ClassScope,
  attempt: AttemptRow,
  student: { id: string; name: string },
): Promise<AttemptGrade> {
  const test = await pinnedTest(ex, attempt);
  const code = await codeResultsOf(ex, scope, attempt.id);
  const scored = scoreAttempt(test, await answersOf(ex, scope, attempt.id), code, [], null);
  if (!scored.ok) throw new Error(scored.message);
  const overrides = await ex
    .select()
    .from(gradeOverrides)
    .where(and(forClass(scope, gradeOverrides), eq(gradeOverrides.attemptId, attempt.id)));
  const byId = new Map(overrides.map((o) => [o.id, o]));
  const history = (await gradesOf(ex, scope, attempt.id)).map((g) =>
    gradeViewOf(g, g.overrideId ? byId.get(g.overrideId) : undefined),
  );
  return {
    attemptId: attempt.id,
    attemptState: attempt.state,
    student,
    automated: scored.value.questions,
    history,
    released: history.find((g) => g.state === 'released') ?? null,
  };
}

/** Instructor: an attempt's grade history and its automated components as they stand now. */
export async function readAttemptGrade(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  now: Date,
): Promise<AttemptGrade | undefined> {
  return db.transaction(async (tx) => {
    const found = await lockReviewable(tx, scope, attemptId, now);
    return found && attemptGradeOf(tx, scope, found.attempt, found.student);
  });
}

export type GradeChange = { expectedGradeId: string | null } & (
  | { source: 'draft'; manual: contracts.ManualMark[]; feedback: contracts.FeedbackItem[] }
  | { source: 'regrade'; reason: string }
  | { source: 'override'; points: number; reason: string }
);

/**
 * Adds a grade row: a draft save (manual points and feedback as given, automated components
 * recomputed), a regrade (automated components recomputed, the rest carried over) or an
 * override (the prior row's components carried over, the points replaced, the prior row kept).
 * The attempt moves to Graded once its grade is complete; a released attempt stays released and
 * its student keeps seeing the released row until the next release.
 */
export async function changeGrade(
  db: Db,
  scope: ClassScope,
  attemptId: string,
  change: GradeChange,
  now: Date,
): Promise<Outcome<AttemptGrade> | AttemptOpen> {
  return db.transaction(async (tx) => {
    const found = await lockReviewable(tx, scope, attemptId, now);
    if (!found) return notFound;
    const { attempt, student } = found;
    if (attempt.state === 'in_progress') return { ok: false, reason: 'attempt_open' };
    if (scope.archived) return classArchived;
    const [latest] = await gradesOf(tx, scope, attempt.id).limit(1);
    if (!latest && change.source !== 'draft') {
      return invalid('This attempt has no grade yet: save a draft grade first');
    }
    if ((latest?.id ?? null) !== change.expectedGradeId) {
      return {
        ok: false,
        reason: 'conflict',
        current: await attemptGradeOf(tx, scope, attempt, student),
      };
    }
    const test = await pinnedTest(tx, attempt);
    const answers = await answersOf(tx, scope, attempt.id);
    let overrideId = latest?.overrideId ?? null;
    let scored: Pick<GradeRow, 'questions' | 'automatedPoints' | 'manualPoints'> & {
      points: number;
      possible: number;
      complete: boolean;
    };
    if (change.source === 'override' && latest) {
      if (change.points > latest.possible) {
        return invalid(`This test is worth at most ${latest.possible} points`);
      }
      const [row] = await tx
        .insert(gradeOverrides)
        .values({
          classId: scope.classId,
          attemptId: attempt.id,
          priorGradeId: latest.id,
          points: change.points,
          reason: change.reason,
          createdBy: scope.user.id,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error('override insert returned no row');
      overrideId = row.id;
      scored = { ...latest, points: change.points, complete: true };
    } else {
      const marks =
        change.source === 'draft'
          ? change.manual
          : (latest?.questions ?? []).flatMap((stored) => {
              const q = test.questions.find((x) => x.id === stored.questionId);
              return (q && markOf(q, stored.manual)) ?? [];
            });
      if (change.source === 'draft') {
        const problem = feedbackProblem(test, answers, change.feedback);
        if (problem) return invalid(problem);
      }
      const [inForce] = overrideId
        ? await tx
            .select({ points: gradeOverrides.points })
            .from(gradeOverrides)
            .where(and(forClass(scope, gradeOverrides), eq(gradeOverrides.id, overrideId)))
        : [];
      const code = await codeResultsOf(tx, scope, attempt.id);
      const result = scoreAttempt(test, answers, code, marks, inForce ?? null);
      if (!result.ok) return invalid(result.message);
      scored = result.value;
    }
    const feedback = change.source === 'draft' ? change.feedback : (latest?.feedback ?? []);
    const [row] = await tx
      .insert(grades)
      .values({
        classId: scope.classId,
        attemptId: attempt.id,
        userId: attempt.userId,
        resourceId: attempt.resourceId,
        resourceRevisionId: attempt.resourceRevisionId,
        graderVersion: attempt.graderVersion,
        number: (latest?.number ?? 0) + 1,
        source: change.source,
        reason: change.source === 'draft' ? null : change.reason,
        questions: scored.questions,
        feedback,
        automatedPoints: scored.automatedPoints,
        manualPoints: scored.manualPoints,
        overrideId,
        points: scored.points,
        possible: scored.possible,
        complete: scored.complete,
        createdBy: scope.user.id,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('grade insert returned no row');
    const open = ['submitted', 'grading', 'needs_review'] as const;
    const next = scored.complete ? 'graded' : attempt.state === 'submitted' ? 'grading' : null;
    if (next && (open as readonly string[]).includes(attempt.state) && next !== attempt.state) {
      await tx
        .update(testAttempts)
        .set({ state: next })
        .where(and(forClass(scope, testAttempts), eq(testAttempts.id, attempt.id)));
    }
    await audit(tx, {
      actorId: scope.user.id,
      action: {
        draft: 'grade.draft_saved',
        regrade: 'grade.regraded',
        override: 'grade.overridden',
      }[change.source],
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'grade',
      targetId: row.id,
      before: latest ? { gradeId: latest.id, points: latest.points } : null,
      after: {
        attemptId: attempt.id,
        number: row.number,
        points: row.points,
        possible: row.possible,
        ...(change.source !== 'draft' && { reason: change.reason }),
      },
      createdAt: now,
    });
    const [moved] = await tx
      .select()
      .from(testAttempts)
      .where(and(forClass(scope, testAttempts), eq(testAttempts.id, attempt.id)));
    return { ok: true, value: await attemptGradeOf(tx, scope, moved ?? attempt, student) };
  });
}

/** What releasing the current grades of these attempts would make visible, and what it skips. */
async function previewOf(ex: Ex, scope: ClassScope, attemptIds: string[]): Promise<Preview> {
  const ids = [...new Set(attemptIds)];
  const attempts = await ex
    .select({ attempt: testAttempts, name: users.name })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(and(reviewable(scope), inArray(testAttempts.id, ids)));
  const current = await ex
    .selectDistinctOn([grades.attemptId])
    .from(grades)
    .where(and(forClass(scope, grades), inArray(grades.attemptId, ids)))
    .orderBy(grades.attemptId, desc(grades.number));
  const byAttempt = new Map(attempts.map((a) => [a.attempt.id, a]));
  const gradeOf = new Map(current.map((g) => [g.attemptId, g]));
  const preview: Preview = { recipients: [], skipped: [] };
  for (const attemptId of ids) {
    const found = byAttempt.get(attemptId);
    const grade = gradeOf.get(attemptId);
    const skip = !found
      ? 'not_found'
      : !grade
        ? 'no_grade'
        : grade.state === 'released'
          ? 'already_released'
          : !grade.complete
            ? 'incomplete'
            : null;
    if (skip || !found || !grade) {
      preview.skipped.push({ attemptId, reason: skip ?? 'not_found' });
      continue;
    }
    preview.recipients.push({
      student: { id: found.attempt.userId, name: found.name },
      attemptId,
      attemptNumber: found.attempt.number,
      resourceId: found.attempt.resourceId,
      gradeId: grade.id,
      gradeNumber: grade.number,
      points: grade.points,
      possible: grade.possible,
    });
  }
  return preview;
}

export const previewRelease = (db: Db, scope: ClassScope, attemptIds: string[]) =>
  previewOf(db, scope, attemptIds);

/**
 * Release feedback (§12, A17): makes exactly the named grade rows visible to their students and
 * records who released them, when, and to whom. If the set differs from what a preview shows now
 * (a newer draft, an attempt already released, an incomplete grade), nothing is released.
 */
export async function releaseGrades(
  db: Db,
  scope: ClassScope,
  entries: { attemptId: string; gradeId: string }[],
  now: Date,
): Promise<Outcome<Release> | ReleaseChanged> {
  if (scope.archived) return classArchived;
  return db.transaction(async (tx) => {
    const ids = [...new Set(entries.map((e) => e.attemptId))];
    await tx
      .select({ id: testAttempts.id })
      .from(testAttempts)
      .where(and(forClass(scope, testAttempts), inArray(testAttempts.id, ids)))
      .orderBy(testAttempts.id)
      .for('update');
    const preview = await previewOf(tx, scope, ids);
    const wanted = new Map(entries.map((e) => [e.attemptId, e.gradeId]));
    const exact =
      ids.length === entries.length &&
      preview.skipped.length === 0 &&
      preview.recipients.every((r) => wanted.get(r.attemptId) === r.gradeId);
    if (!exact) return { ok: false, reason: 'release_changed', preview };
    const [release] = await tx
      .insert(gradeReleases)
      .values({
        classId: scope.classId,
        releasedBy: scope.user.id,
        releasedAt: now,
        recipients: preview.recipients.map((r) => ({
          studentId: r.student.id,
          attemptId: r.attemptId,
          gradeId: r.gradeId,
        })),
      })
      .returning();
    if (!release) throw new Error('release insert returned no row');
    await tx
      .update(grades)
      .set({ state: 'released', releaseId: release.id, releasedAt: now })
      .where(
        and(
          forClass(scope, grades),
          inArray(
            grades.id,
            preview.recipients.map((r) => r.gradeId),
          ),
        ),
      );
    await tx
      .update(testAttempts)
      .set({ state: 'released' })
      .where(
        and(
          forClass(scope, testAttempts),
          inArray(testAttempts.id, ids),
          ne(testAttempts.state, 'in_progress'),
        ),
      );
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grade.released',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'grade_release',
      targetId: release.id,
      after: { recipients: release.recipients },
      createdAt: now,
    });
    return {
      ok: true,
      value: {
        id: release.id,
        releasedBy: release.releasedBy,
        releasedAt: release.releasedAt.toISOString(),
        recipients: preview.recipients,
      },
    };
  });
}

/** The assignment's reported-grade rule: the class's current terms, else the newest attempt's. */
async function ruleOf(
  ex: Ex,
  scope: ClassScope,
  resourceId: string,
  now: Date,
  attempts: AttemptRow[],
): Promise<ReportRule | undefined> {
  const found = await studyableTest(ex, scope, resourceId, now);
  if (found.ok) {
    return settingsOf(found.test, (await assignmentOf(ex, scope, resourceId))?.settings)
      .reportedGrade;
  }
  const newest = [...attempts].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  return newest?.settings.reportedGrade;
}

const summaryOf = (g: GradeRow | undefined) =>
  g
    ? {
        id: g.id,
        number: g.number,
        state: g.state,
        points: g.points,
        possible: g.possible,
        complete: g.complete,
      }
    : null;

const reportable = (attempt: AttemptRow, released: GradeRow | undefined) => ({
  attemptId: attempt.id,
  number: attempt.number,
  selected: attempt.reportSelected,
  grade: released
    ? { id: released.id, points: released.points, possible: released.possible }
    : null,
});

/** Newest grade row and newest released row of each attempt of a test. */
async function gradesByAttempt(ex: Ex, scope: ClassScope, where: ReturnType<typeof and>) {
  const rows = await ex
    .select()
    .from(grades)
    .where(and(forClass(scope, grades), where))
    .orderBy(desc(grades.number));
  const current = new Map<string, GradeRow>();
  const released = new Map<string, GradeRow>();
  for (const g of rows) {
    if (!current.has(g.attemptId)) current.set(g.attemptId, g);
    if (g.state === 'released' && !released.has(g.attemptId)) released.set(g.attemptId, g);
  }
  return { current, released };
}

/**
 * Instructor: each real student's attempts of a test with their current and released grades,
 * and the grade reported under the rule, from released grades only.
 */
export async function testGrades(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<TestGrades>> {
  const attempts = await reviewableAttempts(db, scope, resourceId, now);
  const rule = await ruleOf(
    db,
    scope,
    resourceId,
    now,
    attempts.map((a) => a.attempt),
  );
  if (!rule) return notFound;
  const { current, released } = await gradesByAttempt(db, scope, eq(grades.resourceId, resourceId));
  const students: TestGrades['students'] = [];
  for (const { attempt, name, removed } of attempts) {
    let entry = students.at(-1);
    if (entry?.student.id !== attempt.userId) {
      entry = {
        student: { id: attempt.userId, name },
        removed,
        reported: null,
        selectedAttemptId: null,
        attempts: [],
      };
      students.push(entry);
    }
    if (attempt.reportSelected) entry.selectedAttemptId = attempt.id;
    entry.attempts.push({
      attemptId: attempt.id,
      number: attempt.number,
      state: attempt.state,
      current: summaryOf(current.get(attempt.id)),
      released: summaryOf(released.get(attempt.id)),
    });
  }
  for (const entry of students) {
    const mine = attempts.filter(
      (a) => a.attempt.userId === entry.student.id && a.attempt.state !== 'in_progress',
    );
    entry.reported = reportedOf(
      rule,
      mine.map((a) => reportable(a.attempt, released.get(a.attempt.id))),
    );
  }
  return { ok: true, value: { rule, students } };
}

/** Instructor: the attempt reported for a student under the `instructor_selected` rule. */
export async function selectReported(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: { studentId: string; attemptId: string },
  now: Date,
): Promise<Outcome<{ studentId: string; attemptId: string }>> {
  if (scope.archived) return classArchived;
  return db.transaction(async (tx) => {
    const found = await lockReviewable(tx, scope, input.attemptId, now);
    const attempt = found?.attempt;
    if (!attempt || attempt.userId !== input.studentId || attempt.resourceId !== resourceId) {
      return invalid('This is not an attempt of that student at this test');
    }
    if (attempt.state === 'in_progress')
      return invalid('An attempt in progress cannot be reported');
    const ofStudent = and(
      forClass(scope, testAttempts),
      eq(testAttempts.userId, attempt.userId),
      eq(testAttempts.resourceId, resourceId),
    );
    await tx
      .update(testAttempts)
      .set({ reportSelected: false })
      .where(and(ofStudent, eq(testAttempts.reportSelected, true)));
    await tx
      .update(testAttempts)
      .set({ reportSelected: true })
      .where(and(ofStudent, eq(testAttempts.id, attempt.id)));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grade.report_selected',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'test_attempt',
      targetId: attempt.id,
      after: { studentId: attempt.userId, resourceId },
      createdAt: now,
    });
    return { ok: true, value: input };
  });
}

function releasedViewOf(g: GradeRow) {
  return {
    gradeId: g.id,
    points: g.points,
    possible: g.possible,
    overridden: g.overrideId !== null,
    questions: g.questions.map((q) => ({
      questionId: q.questionId,
      possible: q.possible,
      points: q.points,
      automatedPoints: q.automated?.points ?? null,
      manualPoints: q.manual?.points ?? null,
      criteria: q.manual?.criteria ?? [],
    })),
    feedback: g.feedback,
    releasedAt: (g.releasedAt ?? g.createdAt).toISOString(),
  };
}

/**
 * Student: their own attempts of a test with the newest released grade of each (A17). A draft is
 * never read here, so nothing a student sees changes until an instructor releases it.
 */
export async function myResults(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<MyResults>> {
  const attempts = await ownAttempts(db, scope, resourceId, now);
  const rule = await ruleOf(db, scope, resourceId, now, attempts);
  if (!rule) return notFound;
  const { released } = await gradesByAttempt(
    db,
    scope,
    and(
      eq(grades.userId, scope.user.id),
      eq(grades.resourceId, resourceId),
      eq(grades.state, 'released'),
    ),
  );
  const submitted = attempts.filter((a) => a.state !== 'in_progress');
  return {
    ok: true,
    value: {
      rule,
      reported: reportedOf(
        rule,
        submitted.map((a) => reportable(a, released.get(a.id))),
      ),
      attempts: attempts.map((a) => {
        const grade = released.get(a.id);
        return {
          attemptId: a.id,
          number: a.number,
          status: a.state === 'in_progress' ? 'in_progress' : grade ? 'released' : 'pending',
          grade: grade ? releasedViewOf(grade) : null,
        };
      }),
    },
  };
}
