import { z } from 'zod';
import { classArchived, conflictBody, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { testAttemptStates } from '../test';
import { isWellFormed } from '../wellFormed';

/**
 * Grades of test attempts (§11, §12). Every route is class-scoped. A grade is an append-only
 * history per attempt: each save, regrade or override adds a row and leaves the earlier ones as
 * they were, so manual rubric points, automated results, overrides and releases stay
 * distinguishable. A saved grade is a draft that only instructors see; releasing names the exact
 * grade rows, previewed first, and students read nothing but released rows of their own attempts.
 */

const exampleClass = exampleIds.zero;
const exampleResource = exampleIds.bb;
const exampleAttempt = exampleIds.dd;
const exampleGrade = exampleIds.ee;

const timestamp = z.iso.datetime({ offset: true });
const attemptParams = z.object({ classId: z.uuid(), attemptId: z.uuid() });
const resourceParams = z.object({ classId: z.uuid(), resourceId: z.uuid() });
const questionId = z.string().min(1).max(40);
const points = z.number().min(0).max(100_000);
/** Text Postgres's jsonb refuses (a lone surrogate) is refused here with 400, not a 500. */
const text = (max: number) =>
  z.string().trim().min(1).max(max).refine(isWellFormed, { message: 'contains a lone surrogate' });
const reason = text(500);

export const gradeStates = ['draft', 'released'] as const;
/** What made the row: an instructor's save, a regrade from newer results, or an override. */
export const gradeSources = ['draft', 'regrade', 'override'] as const;

/** Where feedback is attached: the whole attempt, one question, or one line of a code file. */
export const feedbackTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attempt') }),
  z.strictObject({ kind: z.literal('question'), questionId }),
  z.strictObject({
    kind: z.literal('line'),
    questionId,
    path: z.string().min(1).max(200),
    line: z.int().min(1).max(1_000_000),
  }),
]);
export const feedbackItem = z.strictObject({
  target: feedbackTarget,
  text: text(5000),
});
export type FeedbackItem = z.output<typeof feedbackItem>;

/**
 * An instructor's manual points for one question: per rubric criterion when the question has a
 * rubric, otherwise one amount (an explanation without criteria).
 */
export const manualMark = z.strictObject({
  questionId,
  criteria: z
    .array(z.strictObject({ id: questionId, points }))
    .max(20)
    .optional(),
  points: points.optional(),
});
export type ManualMark = z.output<typeof manualMark>;

/**
 * The automated part of a question: `scored` from its answer key or the execution result named
 * by `resultId`; `pending` while the grading run has no result; `unavailable` when it ended in
 * an infrastructure failure (NeedsReview).
 */
export const automatedScore = z.object({
  possible: z.number(),
  points: z.number().nullable(),
  status: z.enum(['scored', 'pending', 'unavailable']),
  resultId: z.uuid().nullable(),
});
export type AutomatedScore = z.output<typeof automatedScore>;

export const manualScore = z.object({
  possible: z.number(),
  /** Null until the instructor marks the question. */
  points: z.number().nullable(),
  criteria: z.array(z.object({ id: z.string(), points: z.number() })),
});
export type ManualScore = z.output<typeof manualScore>;

export const questionScore = z.object({
  questionId: z.string(),
  possible: z.number(),
  automated: automatedScore.nullable(),
  manual: manualScore.nullable(),
  /** Automated plus manual points; null while either part is missing. */
  points: z.number().nullable(),
});
export type QuestionScore = z.output<typeof questionScore>;

export const gradeOverrideView = z.object({
  id: z.uuid(),
  points: z.number(),
  reason: z.string(),
  /** The grade row the override replaced; it is kept unchanged. */
  priorGradeId: z.uuid(),
  createdBy: z.uuid(),
  createdAt: timestamp,
});

export const gradeView = z.object({
  id: z.uuid(),
  attemptId: z.uuid(),
  /** 1 for the attempt's first grade row, then one more per save, regrade or override. */
  number: z.int(),
  state: z.enum(gradeStates),
  source: z.enum(gradeSources),
  /** Why a regrade or override was made; null for a draft save. */
  reason: z.string().nullable(),
  /** The pinned revision whose rubric and answer keys graded the attempt, and its grader. */
  resourceRevisionId: z.uuid(),
  graderVersion: z.string(),
  questions: z.array(questionScore),
  feedback: z.array(feedbackItem),
  automatedPoints: z.number(),
  manualPoints: z.number(),
  override: gradeOverrideView.nullable(),
  /** The grade: the override's points when one is in force, else automated plus manual. */
  points: z.number(),
  possible: z.number(),
  /** Every question has its points (or an override is in force): only then can it be released. */
  complete: z.boolean(),
  createdBy: z.uuid(),
  createdAt: timestamp,
  releaseId: z.uuid().nullable(),
  releasedAt: timestamp.nullable(),
});

/** Instructor: an attempt's grade history and the automated components as they stand now. */
export const attemptGrade = z.object({
  attemptId: z.uuid(),
  attemptState: z.enum(testAttemptStates),
  student: z.object({ id: z.uuid(), name: z.string() }),
  /** Automated components from the answer keys and the latest execution results. */
  automated: z.array(questionScore),
  /** Every grade row, newest first; the first is the current one. */
  history: z.array(gradeView),
  /** The newest released row: what the student sees. */
  released: gradeView.nullable(),
});

export const readAttemptGrade = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/grade',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'An attempt’s grade history, its released grade and its automated components',
  params: attemptParams,
  response: attemptGrade,
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});

const attemptOpen = z.object({ error: z.literal('attempt_open') });
const gradeConflict = z.union([conflictBody(attemptGrade), classArchived, attemptOpen]);
/** The grade row the change is based on; null for an attempt's first grade. */
const expectedGradeId = z.uuid().nullable();

/** Save draft grade: a new draft row; students see nothing of it until it is released. */
export const saveDraftGrade = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/grade',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Save a draft grade with manual rubric points and feedback',
  params: attemptParams,
  body: z.object({
    expectedGradeId,
    manual: z.array(manualMark).max(100),
    feedback: z.array(feedbackItem).max(500),
  }),
  response: attemptGrade,
  errors: { 400: invalidBody, 409: gradeConflict },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: {
      expectedGradeId: null,
      manual: [{ questionId: 'q1', criteria: [{ id: 'clear', points: 2 }] }],
      feedback: [{ target: { kind: 'attempt' }, text: 'Well argued.' }],
    },
  },
});

/**
 * Regrade: a new draft row whose automated components are recomputed from the latest execution
 * results (after a replay or regrade run), with the manual points and feedback carried over.
 */
export const regradeAttempt = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/grade/regrade',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Regrade an attempt from its latest results, with a reason',
  params: attemptParams,
  body: z.object({ expectedGradeId: z.uuid(), reason }),
  response: attemptGrade,
  errors: { 400: invalidBody, 409: gradeConflict },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { expectedGradeId: exampleGrade, reason: 'Replayed after the runner outage' },
  },
});

/** Override: a new draft row with the given points and reason; the prior row is kept. */
export const overrideGrade = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/grade/override',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Override an attempt’s grade with a reason, keeping the prior result',
  params: attemptParams,
  body: z.object({ expectedGradeId: z.uuid(), points, reason }),
  response: attemptGrade,
  errors: { 400: invalidBody, 409: gradeConflict },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt },
    body: { expectedGradeId: exampleGrade, points: 7, reason: 'Check misjudged a correct answer' },
  },
});

/** One student and result a release would make visible. */
export const releaseRecipient = z.object({
  student: z.object({ id: z.uuid(), name: z.string() }),
  attemptId: z.uuid(),
  attemptNumber: z.int(),
  resourceId: z.uuid(),
  gradeId: z.uuid(),
  gradeNumber: z.int(),
  points: z.number(),
  possible: z.number(),
});

export const releasePreview = z.object({
  recipients: z.array(releaseRecipient),
  /** Requested attempts that would release nothing, and why. */
  skipped: z.array(
    z.object({
      attemptId: z.uuid(),
      reason: z.enum(['not_found', 'no_grade', 'already_released', 'incomplete']),
    }),
  ),
});

/** Bulk (or single) release preview: the exact students and grade rows, before confirmation. */
export const previewGradeRelease = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/grade-releases/preview',
  scope: { kind: 'class', role: 'instructor' },
  allowWhenArchived: true,
  summary: 'Preview the students and grades a release would make visible',
  params: z.object({ classId: z.uuid() }),
  body: z.object({ attemptIds: z.array(z.uuid()).min(1).max(500) }),
  response: releasePreview,
  examples: { params: { classId: exampleClass }, body: { attemptIds: [exampleAttempt] } },
});

export const gradeRelease = z.object({
  id: z.uuid(),
  releasedBy: z.uuid(),
  releasedAt: timestamp,
  recipients: z.array(releaseRecipient),
});

/**
 * Release feedback: makes exactly the named grade rows visible. If any is no longer its
 * attempt's current releasable draft, nothing is released and 409 answers a fresh preview.
 */
export const releaseGrades = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/grade-releases',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Release the previewed grades to their students',
  params: z.object({ classId: z.uuid() }),
  body: z.object({
    grades: z
      .array(z.object({ attemptId: z.uuid(), gradeId: z.uuid() }))
      .min(1)
      .max(500),
  }),
  status: 201,
  response: gradeRelease,
  errors: {
    409: z.union([
      z.object({ error: z.literal('release_changed'), preview: releasePreview }),
      classArchived,
    ]),
  },
  examples: {
    params: { classId: exampleClass },
    body: { grades: [{ attemptId: exampleAttempt, gradeId: exampleGrade }] },
  },
});

export const reportedGrade = z.object({
  attemptId: z.uuid(),
  gradeId: z.uuid(),
  points: z.number(),
  possible: z.number(),
});

const gradeSummary = gradeView.pick({
  id: true,
  number: true,
  state: true,
  points: true,
  possible: true,
  complete: true,
});

/** Instructor: each student's attempts of a test, their grades and the reported grade. */
export const readTestGrades = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/grades',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Students’ grades for a test and the grade reported under the assignment’s rule',
  params: resourceParams,
  response: z.object({
    rule: z.enum(['latest', 'highest', 'instructor_selected']),
    students: z.array(
      z.object({
        student: z.object({ id: z.uuid(), name: z.string() }),
        removed: z.boolean(),
        /** From released grades only: what the student is told. */
        reported: reportedGrade.nullable(),
        selectedAttemptId: z.uuid().nullable(),
        attempts: z.array(
          z.object({
            attemptId: z.uuid(),
            number: z.int(),
            state: z.enum(testAttemptStates),
            current: gradeSummary.nullable(),
            released: gradeSummary.nullable(),
          }),
        ),
      }),
    ),
  }),
  errors: { 400: invalidBody },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** Instructor: the attempt reported when the rule is `instructor_selected`. */
export const selectReportedAttempt = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/resources/:resourceId/grades/selection',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Choose which of a student’s attempts is reported',
  params: resourceParams,
  body: z.object({ studentId: z.uuid(), attemptId: z.uuid() }),
  response: z.object({ studentId: z.uuid(), attemptId: z.uuid() }),
  errors: { 400: invalidBody, 409: classArchived },
  examples: {
    params: { classId: exampleClass, resourceId: exampleResource },
    body: { studentId: exampleIds.cc, attemptId: exampleAttempt },
  },
});

/**
 * A released grade as its student reads it: points, rubric criteria and feedback. No reason,
 * author, result id or execution detail; P4-04 adds what the release policy permits.
 */
export const releasedGrade = z.strictObject({
  gradeId: z.uuid(),
  points: z.number(),
  possible: z.number(),
  overridden: z.boolean(),
  questions: z.array(
    z.strictObject({
      questionId: z.string(),
      possible: z.number(),
      points: z.number().nullable(),
      automatedPoints: z.number().nullable(),
      manualPoints: z.number().nullable(),
      criteria: z.array(z.strictObject({ id: z.string(), points: z.number() })),
    }),
  ),
  feedback: z.array(feedbackItem),
  releasedAt: timestamp,
});

/**
 * Student: their own attempts of a test with released grades. `in_progress` is not submitted,
 * `pending` is submitted without a released grade (whatever grading is doing), `released` has
 * one: three states that never share a display.
 */
export const readMyResults = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:resourceId/results',
  scope: { kind: 'class', role: 'any' },
  summary: 'Your attempts of a test with their released grades',
  params: resourceParams,
  response: z.strictObject({
    rule: z.enum(['latest', 'highest', 'instructor_selected']),
    reported: reportedGrade.strict().nullable(),
    attempts: z.array(
      z.strictObject({
        attemptId: z.uuid(),
        number: z.int(),
        status: z.enum(['in_progress', 'pending', 'released']),
        /**
         * Where the attempt is in the §11 diagram, so a `pending` attempt waiting on grading,
         * on an instructor's review (a grading failure) or on release never share a display.
         */
        state: z.enum(testAttemptStates),
        grade: releasedGrade.nullable(),
      }),
    ),
  }),
  errors: { 400: invalidBody },
  examples: { params: { classId: exampleClass, resourceId: exampleResource } },
});

/** One check of a code question's grading run, as the release policy lets its student see it. */
export const resultCheck = z.strictObject({
  name: z.string(),
  status: z.string(),
  visibility: z.enum(['public', 'hidden']),
  message: z.string().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

/**
 * A question of a released attempt: the prompt, the student's own submitted answer, and, only
 * where the attempt's release policy permits, the solution and the hidden checks' details.
 */
export const resultQuestion = z.strictObject({
  questionId: z.string(),
  kind: z.enum(['choice', 'numeric', 'explanation', 'code']),
  prompt: z.string(),
  possible: z.number(),
  options: z.array(z.strictObject({ id: z.string(), label: z.string() })).optional(),
  unit: z.string().optional(),
  /** The rubric criteria, so released criterion points read as labels. */
  rubric: z.array(z.strictObject({ id: z.string(), label: z.string(), points: z.number() })),
  /** The submitted answer as saved; null when the question was left unanswered. */
  answer: z.unknown().nullable(),
  /** Answer key of a choice or numeric question; null unless solutions are released. */
  solution: z
    .strictObject({
      correct: z.array(z.string()).optional(),
      value: z.number().optional(),
      tolerance: z.number().optional(),
    })
    .nullable(),
  /** Submitted files and the grading run's checks; null for a question that is not code. */
  code: z
    .strictObject({
      files: z.array(z.strictObject({ path: z.string(), content: z.string() })),
      /** Public checks always; hidden ones only when hidden test details are released. */
      checks: z.array(resultCheck),
      /** Passed and total among the checks listed, so hidden ones stay uncounted until released. */
      checkTotals: z.strictObject({ passed: z.int(), total: z.int() }),
    })
    .nullable(),
});

/**
 * Student: one released attempt in detail. 404 unless the attempt is the caller's own and has a
 * released grade, so a draft, a pending grading or another student's attempt reveals nothing.
 */
export const readMyResultDetail = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/released',
  scope: { kind: 'class', role: 'any' },
  summary: 'Your released attempt: questions, your answers and what the release policy allows',
  params: attemptParams,
  response: z.strictObject({
    attemptId: z.uuid(),
    gradeId: z.uuid(),
    solutionsShown: z.boolean(),
    hiddenTestDetailsShown: z.boolean(),
    questions: z.array(resultQuestion),
  }),
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});
