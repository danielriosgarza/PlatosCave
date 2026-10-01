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
function stepProblem(step: ExerciseStep): string | undefined {
  const unique = (list: { id: string }[]) => new Set(ids(list)).size === list.length;
  switch (step.kind) {
    case 'single_choice':
    case 'multiple_choice': {
      const correct = step.kind === 'single_choice' ? [step.correct] : step.correct;
      if (!unique(step.options)) return 'option ids must be unique';
      if (!correct.every((c) => ids(step.options).includes(c))) return 'correct names no option';
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
      const { min, max, initial } = step.control;
      const inRange = (v: number) => v >= min && v <= max;
      if (min >= max || !inRange(initial)) return 'control range is invalid';
      if (!unique(step.observations)) return 'observation ids must be unique';
      return step.compare.every(inRange) ? undefined : 'compare values must be in range';
    }
    default:
      return undefined;
  }
}

export const exerciseV1 = z
  .object({
    schema: z.literal('exercise.v1'),
    steps: z.array(exerciseStep).min(1).max(20),
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
