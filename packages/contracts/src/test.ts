import { z } from 'zod';
import { RUNNER_BOUNDS, RunnerCheck, RunnerPath, RunnerRuntimeId } from './runner';

/**
 * `test.v1` (§11): the content of a `test` resource revision. A test mixes choice, numeric,
 * explanation and code questions. Answer keys, rubrics, hidden checks and hidden files stay on
 * the server: students receive `testQuestionView`. The code question is `codeTask.v1` of
 * docs/design/runner.md §8.1; P3-18 adds its publication validation.
 */

const questionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const label = z.string().trim().min(1).max(200);
const prose = z.string().trim().min(1).max(8000);
const points = z.number().min(0).max(1000);
const timestamp = z.iso.datetime({ offset: true });

export const rubricCriterion = z.object({ id: questionId, label, points });

const common = {
  id: questionId,
  prompt: prose,
  points,
  /** Criteria for manual points (§11); kept with the revision, so a started attempt keeps them. */
  rubric: z.array(rubricCriterion).max(20).default([]),
};

export const choiceQuestion = z.object({
  ...common,
  kind: z.literal('choice'),
  options: z
    .array(z.object({ id: questionId, label }))
    .min(2)
    .max(12),
  multiple: z.boolean().default(false),
  correct: z.array(questionId).min(1),
});

export const numericQuestion = z.object({
  ...common,
  kind: z.literal('numeric'),
  answer: z.number(),
  tolerance: z.number().min(0),
  unit: z.string().max(20).optional(),
});

export const explanationQuestion = z.object({
  ...common,
  kind: z.literal('explanation'),
  maxLength: z.int().min(1).max(20_000).default(5000),
});

export const codeFile = z.object({
  path: RunnerPath,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  /** Editable files are the student's answer; the others are the question's. */
  editable: z.boolean(),
  /** Never shown to students and never part of a sample run (design §8.1). */
  hidden: z.boolean(),
});

/** A runner check with the points it is worth; the points are for grading and never sent. */
const gradedCheck = z.looseObject({ points: points.default(1) }).transform((value, ctx) => {
  const { points: worth, ...check } = value;
  const parsed = RunnerCheck.safeParse(check);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return { ...parsed.data, points: worth };
});

const limit = (name: keyof typeof RUNNER_BOUNDS) =>
  z.int().min(RUNNER_BOUNDS[name].min).max(RUNNER_BOUNDS[name].max);

export const codeQuestion = z.object({
  ...common,
  kind: z.literal('code'),
  runtime: RunnerRuntimeId,
  files: z.array(codeFile).min(1).max(64),
  allowedPackages: z.array(z.string().min(1).max(100)).max(100).default([]),
  limits: z
    .object({
      wallSeconds: limit('wallSeconds'),
      memoryMiB: limit('memoryMiB'),
      outputBytes: limit('outputBytes'),
    })
    .partial()
    .optional(),
  checks: z.array(gradedCheck).min(1).max(50),
});

export const testQuestion = z.discriminatedUnion('kind', [
  choiceQuestion,
  numericQuestion,
  explanationQuestion,
  codeQuestion,
]);
export type TestQuestion = z.output<typeof testQuestion>;

/** Assignment terms (§11). Every field is shown to the student before they start. */
export const assignmentSettings = z.object({
  /** Attempts each student may start. */
  attempts: z.int().min(1).max(20),
  /** Minutes from the start of an attempt; null when untimed. */
  durationMinutes: z
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .nullable(),
  opensAt: timestamp.nullable(),
  closesAt: timestamp.nullable(),
  /** The IANA time zone the times are shown in. */
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone'),
  /** After `closesAt`, nothing is accepted, or work is accepted and marked late until `until`. */
  late: z.discriminatedUnion('policy', [
    z.object({ policy: z.literal('none') }),
    z.object({ policy: z.literal('accept'), until: timestamp }),
  ]),
  /** When results, solutions and hidden test details reach students. */
  release: z.object({
    results: z.enum(['manual', 'scheduled']),
    at: timestamp.nullable(),
    solutions: z.enum(['never', 'with_results']),
    hiddenTestDetails: z.boolean(),
  }),
  /** Which attempt's grade is reported. */
  reportedGrade: z.enum(['latest', 'highest', 'instructor_selected']),
  allowedMaterials: z.string().max(2000),
});
export type AssignmentSettings = z.output<typeof assignmentSettings>;
/** Fields a revision (author defaults) or a class assignment sets; the rest are inherited. */
export const assignmentSettingsPatch = assignmentSettings.partial();
export type AssignmentSettingsPatch = z.output<typeof assignmentSettingsPatch>;

/** §11 defaults: one attempt, untimed, no late submission, manual release of results. */
export const defaultAssignmentSettings: AssignmentSettings = {
  attempts: 1,
  durationMinutes: null,
  opensAt: null,
  closesAt: null,
  timeZone: 'UTC',
  late: { policy: 'none' },
  release: { results: 'manual', at: null, solutions: 'never', hiddenTestDetails: false },
  reportedGrade: 'latest',
  allowedMaterials: '',
};

/** Defaults, then the revision's settings, then the class's. */
export const mergeSettings = (
  ...patches: (AssignmentSettingsPatch | undefined)[]
): AssignmentSettings => Object.assign({}, defaultAssignmentSettings, ...patches);

/** Why merged settings cannot be applied; empty when they can. */
export function settingsProblems(s: AssignmentSettings): string[] {
  const problems: string[] = [];
  const at = (t: string | null) => (t === null ? null : Date.parse(t));
  const opens = at(s.opensAt);
  const closes = at(s.closesAt);
  if (opens !== null && closes !== null && closes <= opens) {
    problems.push('the closing time must be after the opening time');
  }
  if (s.late.policy === 'accept') {
    if (closes === null) problems.push('late submission needs a closing time');
    else if (Date.parse(s.late.until) <= closes) {
      problems.push('late submission must end after the closing time');
    }
  }
  if ((s.release.results === 'scheduled') !== (s.release.at !== null)) {
    problems.push('a scheduled release needs a release time, and only it has one');
  }
  return problems;
}

export const testV1 = z
  .object({
    questions: z.array(testQuestion).min(1).max(100),
    /** The author's defaults for the assignment; a class may override them. */
    settings: assignmentSettingsPatch.optional(),
  })
  .superRefine((test, ctx) => {
    const ids = new Set<string>();
    test.questions.forEach((q, i) => {
      const path = ['questions', i];
      if (ids.has(q.id)) ctx.addIssue({ code: 'custom', message: 'duplicate question id', path });
      ids.add(q.id);
      const criteria = new Set(q.rubric.map((r) => r.id));
      if (criteria.size !== q.rubric.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate criterion id',
          path: [...path, 'rubric'],
        });
      }
      if (q.kind === 'choice') {
        const options = new Set(q.options.map((o) => o.id));
        if (options.size !== q.options.length || !q.correct.every((c) => options.has(c))) {
          ctx.addIssue({ code: 'custom', message: 'correct answers must be options', path });
        }
        if (!q.multiple && q.correct.length !== 1) {
          ctx.addIssue({ code: 'custom', message: 'a single choice has one answer', path });
        }
      }
      if (q.kind === 'code') {
        const paths = new Set(q.files.map((f) => f.path));
        if (paths.size !== q.files.length) {
          ctx.addIssue({ code: 'custom', message: 'duplicate file path', path });
        }
        if (!q.files.some((f) => f.editable && !f.hidden)) {
          ctx.addIssue({ code: 'custom', message: 'a code question needs an editable file', path });
        }
      }
    });
  });
export type TestV1 = z.output<typeof testV1>;

/** What a student sees of a question: no answer key, rubric, hidden check or hidden file. */
export const testQuestionView = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    id: z.string(),
    prompt: z.string(),
    points: z.number(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    multiple: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('numeric'),
    id: z.string(),
    prompt: z.string(),
    points: z.number(),
    unit: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('explanation'),
    id: z.string(),
    prompt: z.string(),
    points: z.number(),
    maxLength: z.int(),
  }),
  z.strictObject({
    kind: z.literal('code'),
    id: z.string(),
    prompt: z.string(),
    points: z.number(),
    runtime: z.string(),
    allowedPackages: z.array(z.string()),
    files: z.array(
      z.strictObject({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        editable: z.boolean(),
      }),
    ),
    limits: z.strictObject({
      wallSeconds: z.int(),
      memoryMiB: z.int(),
      outputBytes: z.int(),
    }),
    /** The sample tests: public checks only, without points. */
    sampleChecks: z.array(z.record(z.string(), z.unknown())),
  }),
]);
export type TestQuestionView = z.input<typeof testQuestionView>;

/**
 * Attempt states (§11). `Available` is not stored: it is the eligibility to start. Grading
 * states are entered by the grading items (P3-16, P4-01).
 */
export const testAttemptStates = [
  'in_progress',
  'submitted',
  'grading',
  'needs_review',
  'graded',
  'released',
] as const;
export type TestAttemptState = (typeof testAttemptStates)[number];

/** The moves of the §11 state diagram; anything else is refused. */
export const testAttemptMoves: Record<TestAttemptState, readonly TestAttemptState[]> = {
  in_progress: ['submitted'],
  submitted: ['grading'],
  grading: ['needs_review', 'graded'],
  needs_review: ['grading'],
  graded: ['released'],
  released: [],
};
