import { z } from 'zod';

/**
 * `exercise.v1` (§9): the content of an `exercise` resource revision. An exercise is a short
 * sequence of steps; each step has a prompt, a response schema (its `kind`), a validation
 * rule, feedback, optional hints in sequence, a solution, and a completion rule. Answer keys,
 * feedback and solutions stay on the server: students receive `exerciseStepView`.
 */

const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const label = z.string().trim().min(1).max(200);
const prose = z.string().trim().min(1).max(4000);
const option = z.object({ id: stepId, label });

const common = {
  id: stepId,
  /** Short name on the step track, e.g. "Predict". */
  title: label,
  prompt: prose,
  /** Revealed one at a time; each reveal is recorded (§9). */
  hints: z.array(prose).max(10).default([]),
  /** Shown by Show solution, which completes the step with help. */
  solution: prose.optional(),
};

/** Shown after a correct check, and after a wrong one unless a more specific message applies. */
const feedback = z.object({ correct: prose, incorrect: prose });

export const numericStep = z.object({
  ...common,
  kind: z.literal('numeric'),
  answer: z.number(),
  /** Accepted absolute distance from `answer`. */
  tolerance: z.number().min(0),
  unit: z.string().max(20).optional(),
  feedback: feedback.extend({ low: prose.optional(), high: prose.optional() }),
});

const choiceOption = option.extend({ feedback: prose.optional() });
const choice = {
  options: z.array(choiceOption).min(2).max(12),
  /** Present options in an order drawn from the attempt's seed. */
  shuffle: z.boolean().default(false),
  feedback,
};

export const singleChoiceStep = z.object({
  ...common,
  kind: z.literal('single_choice'),
  ...choice,
  correct: stepId,
});

export const multipleChoiceStep = z.object({
  ...common,
  kind: z.literal('multiple_choice'),
  ...choice,
  correct: z.array(stepId).min(1),
});

export const orderingStep = z.object({
  ...common,
  kind: z.literal('ordering'),
  items: z.array(option).min(2).max(12),
  /** Item ids in the correct order. */
  order: z.array(stepId).min(2),
  shuffle: z.boolean().default(true),
  feedback,
});

export const matchingStep = z.object({
  ...common,
  kind: z.literal('matching'),
  prompts: z.array(option).min(2).max(12),
  choices: z.array(option).min(2).max(12),
  /** Prompt id → choice id. */
  pairs: z.record(stepId, stepId),
  shuffle: z.boolean().default(true),
  feedback,
});

/** Explain: completed by saving non-whitespace text; nothing judges its reasoning (§9). */
export const textStep = z.object({
  ...common,
  kind: z.literal('text'),
  maxLength: z.int().min(1).max(20_000).default(4000),
  /** Shown once the text is saved. */
  feedback: z.object({ saved: prose }),
});

/**
 * A control the learner adjusts with keyboard equivalents, plus the observations the author
 * chose to expose; nothing else (no pointer movements) is recorded (§9). The step completes
 * once every value in `compare` has been checked in the attempt.
 */
export const simulationStep = z.object({
  ...common,
  kind: z.literal('simulation'),
  control: z.object({
    name: stepId,
    label,
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    initial: z.number(),
  }),
  observations: z.array(option.extend({ unit: z.string().max(20).optional() })).max(10),
  compare: z.array(z.number()).min(1).max(10),
  feedback: z.object({ correct: prose, incomplete: prose }),
});

/** Placeholder until code tasks run on the execution service (Phase 3): code is saved only. */
export const codeStep = z.object({
  ...common,
  kind: z.literal('code'),
  language: z.enum(['python', 'r']),
  starter: z.string().max(20_000).default(''),
  feedback: z.object({ saved: prose }),
});

export const exerciseStep = z.discriminatedUnion('kind', [
  numericStep,
  singleChoiceStep,
  multipleChoiceStep,
  orderingStep,
  matchingStep,
  textStep,
  simulationStep,
  codeStep,
]);
export type ExerciseStep = z.output<typeof exerciseStep>;

const ids = (list: { id: string }[]) => list.map((o) => o.id);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/** Cross-field rules a step's own shape cannot express; the message names what is wrong. */
/**
 * Whether `value` is a point the simulation control offers: min + k·step for a whole k. Both
 * sides are snapped to six decimals, as the control does when it sends a value, so authors
 * and students agree for large step counts and for values below the rounding.
 */
export function onControlGrid(value: number, min: number, step: number): boolean {
  const k = Math.round((value - min) / step);
  return Number.isFinite(k) && Number(value.toFixed(6)) === Number((min + k * step).toFixed(6));
}

function stepProblem(step: ExerciseStep): string | undefined {
  const unique = (list: { id: string }[]) => new Set(ids(list)).size === list.length;
  switch (step.kind) {
    case 'single_choice':
    case 'multiple_choice': {
      const correct = step.kind === 'single_choice' ? [step.correct] : step.correct;
      if (!unique(step.options)) return 'option ids must be unique';
      if (!correct.every((c) => ids(step.options).includes(c)))
        return correct.some((c) => c === '') ? 'tick a correct option' : 'correct names no option';
      return new Set(correct).size === correct.length ? undefined : 'correct repeats an option';
    }
    case 'ordering':
      return sameSet(step.order, ids(step.items)) ? undefined : 'order must list every item once';
    case 'matching':
      if (!unique(step.prompts) || !unique(step.choices)) return 'ids must be unique';
      if (!sameSet(Object.keys(step.pairs), ids(step.prompts))) return 'pair every prompt once';
      return Object.values(step.pairs).every((c) => ids(step.choices).includes(c))
        ? undefined
        : 'pairs name no choice';
    case 'simulation': {
      const { min, max, initial, step: size } = step.control;
      const inRange = (v: number) => v >= min && v <= max;
      // The control only offers min + k·step, so a value off that grid could never be checked.
      const onGrid = (v: number) => onControlGrid(v, min, size);
      if (min >= max || !inRange(initial)) return 'control range is invalid';
      if (!onGrid(initial)) return 'initial value must be one the control offers (min + k·step)';
      if (!unique(step.observations)) return 'observation ids must be unique';
      if (!step.compare.every(inRange)) return 'compare values must be in range';
      return step.compare.every(onGrid)
        ? undefined
        : 'compare values must be ones the control offers (min + k·step)';
    }
    default:
      return undefined;
  }
}

/**
 * How credit treats help when an exercise is assigned for credit (§9). Practice is ungraded
 * unless `credit` is present; the policy is shown to the student before starting, and Show
 * solution always completes a step "with help", never silently as independent work.
 */
export const hintPolicies = ['free', 'reduces_credit', 'forfeits_credit'] as const;
export const exerciseCredit = z.object({
  points: z.number().positive().max(1000),
  hintPolicy: z.enum(hintPolicies),
});
export type ExerciseCredit = z.output<typeof exerciseCredit>;

export const exerciseV1 = z
  .object({
    schema: z.literal('exercise.v1'),
    steps: z.array(exerciseStep).min(1).max(20),
    /** Absent for ungraded practice. */
    credit: exerciseCredit.optional(),
  })
  .superRefine((exercise, ctx) => {
    if (new Set(exercise.steps.map((s) => s.id)).size !== exercise.steps.length) {
      ctx.addIssue({ code: 'custom', message: 'step ids must be unique', path: ['steps'] });
    }
    exercise.steps.forEach((step, i) => {
      const problem = stepProblem(step);
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['steps', i] });
    });
  });
export type ExerciseV1 = z.output<typeof exerciseV1>;

/** Author wording for the zod issue shapes an editor form can produce; others pass through. */
function issueWords(issue: z.core.$ZodIssue, rest: PropertyKey[]): string {
  const field = rest.filter((k) => typeof k === 'string').at(-1);
  const inList = typeof rest.at(-1) === 'number';
  if (issue.code === 'invalid_type' && issue.expected === 'number') {
    return inList ? 'values must be numbers' : 'must be a number';
  }
  if (issue.code === 'invalid_type' && issue.expected === 'string') return 'must be filled in';
  if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) <= 1) {
    return 'must not be empty';
  }
  if (issue.code === 'too_small' && issue.origin === 'array') {
    return field === 'correct' ? 'tick a correct option' : `needs at least ${issue.minimum}`;
  }
  if (issue.code === 'too_small' && issue.origin === 'number') {
    return issue.inclusive === false
      ? `must be greater than ${issue.minimum}`
      : `must be at least ${issue.minimum}`;
  }
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return `must be at most ${issue.maximum} characters`;
  }
  if (issue.code === 'too_big' && issue.origin === 'array') {
    return `allows at most ${issue.maximum}`;
  }
  if (issue.code === 'invalid_format' && issue.format === 'regex') {
    return field === 'correct'
      ? 'tick a correct option'
      : 'must start with a lowercase letter or digit and use only lowercase letters, digits, - and _ (at most 40)';
  }
  return issue.message;
}

/** Path segments as an author reads them: names as they are, list positions counted from 1. */
const where = (path: PropertyKey[]) =>
  path.map((k) => (typeof k === 'number' ? `#${k + 1}` : String(k))).join(' · ');

/**
 * Every problem that stops `content` from being a valid exercise, in author-readable words
 * ("Step 2 “Inspect” · compare values …"); empty when it is valid.
 */
export function exerciseProblems(content: unknown): string[] {
  const parsed = exerciseV1.safeParse(content);
  if (parsed.success) return [];
  const steps = (content as { steps?: { title?: unknown }[] } | null)?.steps;
  // An unticked option fails the id pattern and the step's own check; say it once.
  const issues = parsed.error.issues.filter(
    (issue, _i, all) =>
      !(
        issue.code === 'invalid_format' &&
        issue.path.at(-1) === 'correct' &&
        all.some(
          (o) =>
            o.code === 'custom' &&
            o.message === 'tick a correct option' &&
            o.path[1] === issue.path[1],
        )
      ),
  );
  return issues.map((issue) => {
    const [head, index, ...rest] = issue.path;
    const words =
      issue.code === 'custom' ? issue.message : issueWords(issue, rest.length ? rest : issue.path);
    if (head !== 'steps' || typeof index !== 'number') {
      return issue.path.length ? `${where(issue.path)}: ${words}` : issue.message;
    }
    const title = steps?.[index]?.title;
    const step = `Step ${index + 1}${typeof title === 'string' && title ? ` “${title}”` : ''}`;
    return rest.length ? `${step} · ${where(rest)}: ${words}` : `${step}: ${words}`;
  });
}

/** Responses per step kind; the server parses a check against its step's kind. */
export const exerciseResponse = {
  numeric: z.number(),
  single_choice: stepId,
  multiple_choice: z.array(stepId).max(12),
  ordering: z.array(stepId).max(12),
  matching: z.record(stepId, stepId),
  text: z.string(),
  simulation: z.object({
    value: z.number(),
    /** Only the step's declared observations; unknown keys are refused. */
    observations: z.record(stepId, z.number()).default({}),
  }),
  code: z.string().max(20_000),
} as const satisfies Record<ExerciseStep['kind'], z.ZodType>;

/** What a student sees of a step: no answer key, feedback, hints or solution text. */
export const exerciseStepView = z.object({
  id: z.string(),
  kind: z.enum([
    'numeric',
    'single_choice',
    'multiple_choice',
    'ordering',
    'matching',
    'text',
    'simulation',
    'code',
  ]),
  title: z.string(),
  prompt: z.string(),
  hintCount: z.int(),
  hasSolution: z.boolean(),
  unit: z.string().optional(),
  /** Choice options or ordering items, in the order the attempt's seed drew. */
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  prompts: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  control: simulationStep.shape.control.optional(),
  observations: z
    .array(z.object({ id: z.string(), label: z.string(), unit: z.string().optional() }))
    .optional(),
  compare: z.array(z.number()).optional(),
  language: z.enum(['python', 'r']).optional(),
  starter: z.string().optional(),
  maxLength: z.int().optional(),
});
