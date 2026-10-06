import { z } from 'zod';
import { classArchived, defineRoute, invalidBody } from '../define';
import { exampleIds } from '../examples';
import { RUNNER_MAX_FILES, RunnerPath } from '../runner';
import { isWellFormed } from '../wellFormed';

/**
 * Code runs of a test attempt (§11; docs/design/runner.md §2, §8.6). Every route is class-scoped
 * and lives under the attempt. A student reaches only their own attempt's `sample` runs: a
 * grading, replay or regrade run of the same attempt answers 404 to them, because its outcome
 * ran next to hidden checks and reaches students only through released grades. Instructors read
 * every run of the class's attempts with the full outcome, hidden checks included.
 */

const exampleClass = exampleIds.zero;
const exampleAttempt = exampleIds.dd;
const exampleRun = exampleIds.ee;

const timestamp = z.iso.datetime({ offset: true });
const attemptParams = z.object({ classId: z.uuid(), attemptId: z.uuid() });
const questionId = z.string().min(1).max(40);

/** Row states (design §8.3); `queued` and `running` are read from the queue while unsettled. */
export const executionStates = [
  'queued',
  'running',
  'passed',
  'failed',
  'time_limited',
  'resource_exhausted',
  'cancelled',
  'infrastructure_error',
] as const;
export const executionState = z.enum(executionStates);
export type ExecutionState = z.infer<typeof executionState>;
export const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set(
  executionStates.filter((s) => s !== 'queued' && s !== 'running'),
);

export const executionReasons = ['sample', 'grading', 'replay', 'regrade', 'preview'] as const;
export const executionCheckSets = ['public', 'full'] as const;

/**
 * Text JSON can carry but no runner can: a lone surrogate (`"\ud800"`). It is refused here with
 * 400, before it could fail the snapshot write or the harness and show as Run unavailable.
 */
const wellFormed = z.string().refine(isWellFormed, {
  message: 'contains a lone surrogate',
});

/** The editable files of a code answer as the editor holds them when Run is pressed. */
export const runFiles = z
  .array(z.strictObject({ path: RunnerPath, content: wellFormed }))
  .min(1)
  .max(RUNNER_MAX_FILES);

/** One public check's result: the harness's fields, never a visibility, point or hidden name. */
export const publicCheckResult = z.strictObject({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'error', 'timeout', 'skipped']),
  errorKind: z.enum(['exception', 'exit', 'signal', 'memory', 'spawn', 'harness']).optional(),
  durationMs: z.int(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
  exitCode: z.int().optional(),
  signal: z.int().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

/**
 * What a student sees of one of their sample runs (design §8.6). `codeHash` names the snapshot
 * the output belongs to, so the editor labels it out of date once the code changes (A12).
 */
export const studentRun = z.strictObject({
  runId: z.uuid(),
  state: executionState,
  codeHash: z.string(),
  /** Jobs the queue serves before this one; present only while it waits in the queue. */
  queuePosition: z.int().min(0).optional(),
  queuedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  result: z
    .strictObject({
      status: z.enum(['passed', 'failed', 'time_limited', 'resource_exhausted']),
      runtime: z
        .strictObject({ language: z.enum(['python', 'r']), version: z.string() })
        .optional(),
      compileError: z
        .strictObject({ file: z.string(), line: z.int().optional(), message: z.string() })
        .optional(),
      checks: z.array(publicCheckResult),
      truncated: z.boolean(),
      durationMs: z.int(),
    })
    .optional(),
});
export type StudentRun = z.input<typeof studentRun>;

/** An instructor's view of any run of the class: the stored outcome, hidden checks included. */
export const instructorRun = z.strictObject({
  runId: z.uuid(),
  state: executionState,
  questionId,
  questionRevisionId: z.uuid(),
  reason: z.enum(executionReasons),
  checkSet: z.enum(executionCheckSets),
  codeHash: z.string(),
  graderVersion: z.string(),
  runtimeId: z.string(),
  imageRef: z.string(),
  queuePosition: z.int().min(0).optional(),
  queuedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  infrastructureAttempts: z.int().nullable(),
  /** Why the run is `infrastructure_error`; null otherwise. */
  failure: z.strictObject({ kind: z.string(), message: z.string() }).nullable(),
  requestedBy: z.uuid().nullable(),
  note: z.string().nullable(),
  supersededBy: z.uuid().nullable(),
  result: z
    .strictObject({
      status: z.enum(['passed', 'failed', 'time_limited', 'resource_exhausted']),
      imageId: z.string(),
      imageDigest: z.string().nullable(),
      harnessVersion: z.string(),
      outcome: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
export type InstructorRun = z.input<typeof instructorRun>;

/** Students get `studentRun`, instructors `instructorRun`; the strict student shape is first. */
const anyRun = z.union([studentRun, instructorRun]);

const tooManyRuns = z.object({
  error: z.literal('too_many_runs'),
  active: z.int(),
  message: z.string(),
});

/**
 * Run sample tests (§2 steps 2–4): `202` with the new run, or `200` with an identical run of this
 * attempt (`reused`). The 202 run's `state` is `queued` unless a cancel, a read or a result
 * settled it while it was being sent.
 */
export const requestRun = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/questions/:questionId/runs',
  scope: { kind: 'class', role: 'student' },
  summary: 'Run the sample tests of a code question on your current files',
  params: attemptParams.extend({ questionId }),
  body: z.object({ files: runFiles }),
  status: 202,
  alternativeStatus: 200,
  response: studentRun.extend({ reused: z.boolean() }),
  errors: {
    400: invalidBody,
    409: z.union([z.object({ error: z.literal('attempt_closed') }), classArchived]),
    429: tooManyRuns,
  },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt, questionId: 'q1' },
    body: { files: [{ path: 'solution.py', content: 'def mean(xs):\n    return 0\n' }] },
  },
});

export const readRun = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/runs/:runId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read one run: a student their sample run, an instructor any run with its outcome',
  params: attemptParams.extend({ runId: z.uuid() }),
  response: anyRun,
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt, runId: exampleRun } },
});

/** The latest run of a question (restores the output panel after a reload). */
export const latestRun = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/questions/:questionId/runs',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read the latest run of a question; for a student, their latest sample run',
  params: attemptParams.extend({ questionId }),
  query: z.object({ latest: z.literal('1') }),
  response: z.object({ run: anyRun.nullable() }),
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt, questionId: 'q1' },
    query: { latest: '1' },
  },
});

/** Cancels a queued sample run; one already running answers 409 and runs to its bounded end. */
export const cancelRun = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/runs/:runId/cancel',
  scope: { kind: 'class', role: 'student' },
  allowWhenArchived: true,
  summary: 'Cancel your queued sample run',
  params: attemptParams.extend({ runId: z.uuid() }),
  response: studentRun,
  errors: { 409: z.object({ error: z.literal('running') }) },
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt, runId: exampleRun } },
});

/**
 * Instructor: runs a submitted attempt's grading again (design §9). A replay pins the image the
 * original run used and keeps its grader version; a regrade uses the current image and needs a
 * note. Both create new records and leave the original ones as they are.
 */
export const requestReplay = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/test-attempts/:attemptId/questions/:questionId/replays',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Replay or regrade the grading run of a question of a submitted attempt',
  params: attemptParams.extend({ questionId }),
  body: z
    .object({
      reason: z.enum(['replay', 'regrade']),
      note: z.string().trim().max(500).default(''),
    })
    .refine((b) => b.reason !== 'regrade' || b.note.length > 0, {
      message: 'a regrade needs a note',
      path: ['note'],
    }),
  status: 202,
  response: z.object({ runId: z.uuid(), state: executionState }),
  errors: {
    400: invalidBody,
    409: z.union([
      z.object({ error: z.enum(['attempt_open', 'no_grading_run', 'no_result']) }),
      classArchived,
    ]),
  },
  examples: {
    params: { classId: exampleClass, attemptId: exampleAttempt, questionId: 'q1' },
    body: { reason: 'regrade', note: 'Runner image updated' },
  },
});

/** Instructor: every run of the attempt with its outcome, hidden checks included. */
export const attemptResults = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/test-attempts/:attemptId/results',
  scope: { kind: 'class', role: 'instructor' },
  summary: 'Every code run of an attempt with its stored outcome',
  params: attemptParams,
  response: z.object({ runs: z.array(instructorRun) }),
  examples: { params: { classId: exampleClass, attemptId: exampleAttempt } },
});

const previewParams = z.object({ courseId: z.uuid(), resourceId: z.uuid() });

/**
 * Instructor preview run of a code question of a draft test (§12: "Preview can run sample and
 * hidden checks in an isolated instructor context"; design §8.1, §8.3). It runs in the oldest
 * live class of the course the caller teaches, as that class's preview principal, through the
 * same queue and runner as a student's run, with no attempt and no per-user cap. `set: 'full'`
 * includes the hidden checks and files. `files` are the editable files to run (a reference
 * solution); omitted, the starter files run. The answer is the instructor view, hidden checks
 * included. `no_class`: the caller teaches no live class of the course.
 */
export const requestPreviewRun = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/resources/:resourceId/questions/:questionId/preview-runs',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Run the sample or all checks of a draft code question in the instructor preview',
  params: previewParams.extend({ questionId }),
  body: z.object({ set: z.enum(executionCheckSets), files: runFiles.optional() }),
  status: 202,
  response: instructorRun,
  errors: {
    400: invalidBody,
    409: z.object({ error: z.literal('no_class'), message: z.string() }),
  },
  examples: {
    params: { courseId: exampleClass, resourceId: exampleRun, questionId: 'q1' },
    body: {
      set: 'full',
      files: [{ path: 'solution.py', content: 'def mean(xs):\n    return 0\n' }],
    },
  },
});

export const readPreviewRun = defineRoute({
  method: 'GET',
  path: '/api/courses/:courseId/preview-runs/:runId',
  scope: { kind: 'course', role: 'editor' },
  summary: 'Read one of your instructor preview runs, hidden checks included',
  params: z.object({ courseId: z.uuid(), runId: z.uuid() }),
  response: instructorRun,
  examples: { params: { courseId: exampleClass, runId: exampleRun } },
});
