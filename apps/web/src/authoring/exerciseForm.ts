import {
  type ExerciseStep,
  type ExerciseV1,
  exerciseProblems,
  exerciseV1,
  type hintPolicies,
} from '@parallax/contracts';

/**
 * The exercise editor's working copy. Every field is text or a boolean so a half-typed form is
 * representable; `toContent` turns it into `exercise.v1` and `exerciseProblems` says what is
 * still wrong. Ids are generated here and kept stable, so reordering never changes what a
 * recorded attempt refers to.
 */

export type StepKind = ExerciseStep['kind'];

export const kindNames: Record<StepKind, string> = {
  numeric: 'Numeric answer',
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  ordering: 'Ordering',
  matching: 'Matching',
  text: 'Explanation',
  simulation: 'Simulation control',
  code: 'Code task',
};

export interface Row {
  id: string;
  label: string;
  /** Choice feedback, unit, or the matched choice label, by step kind. */
  extra: string;
  /** Marks the correct option of a choice step. */
  correct: boolean;
  /** Matching: id of the choice this prompt is paired with, kept so saves do not renumber it. */
  choiceId?: string;
}

export interface DraftStep {
  id: string;
  kind: StepKind;
  title: string;
  prompt: string;
  hints: string[];
  solution: string;
  // Feedback texts; which ones apply depends on the kind.
  correct: string;
  incorrect: string;
  low: string;
  high: string;
  incomplete: string;
  saved: string;
  // numeric
  answer: string;
  tolerance: string;
  unit: string;
  // choice, ordering, matching, simulation observations
  rows: Row[];
  /** Matching: choices no prompt is paired with. */
  distractors: Row[];
  shuffle: boolean;
  // simulation
  controlName: string;
  controlLabel: string;
  min: string;
  max: string;
  stepSize: string;
  initial: string;
  compare: string;
  // text, code
  maxLength: string;
  language: 'python' | 'r';
  starter: string;
}

export type HintPolicy = (typeof hintPolicies)[number];

export interface DraftExercise {
  steps: DraftStep[];
  /** Why the stored definition could not be loaded; empty when it loaded or there is none. */
  loadProblems: string[];
  /** Empty for ungraded practice. */
  points: string;
  hintPolicy: HintPolicy;
}

const text = (v: string) => v.trim();
const optional = <T extends object>(key: string, v: string): T | Record<string, never> =>
  text(v) ? ({ [key]: text(v) } as T) : {};

export function nextId(prefix: string, taken: string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function blankStep(kind: StepKind, taken: string[]): DraftStep {
  const row = (n: number, correct = false): Row => ({
    id: `o${n}`,
    label: '',
    extra: '',
    correct,
  });
  const base: DraftStep = {
    id: nextId('step', taken),
    kind,
    title: '',
    prompt: '',
    hints: [],
    solution: '',
    correct: '',
    incorrect: '',
    low: '',
    high: '',
    incomplete: '',
    saved: '',
    answer: '',
    tolerance: '0',
    unit: '',
    rows: [],
    distractors: [],
    shuffle: false,
    controlName: 'value',
    controlLabel: '',
    min: '',
    max: '',
    stepSize: '1',
    initial: '',
    compare: '',
    maxLength: '4000',
    language: 'python',
    starter: '',
  };
  switch (kind) {
    case 'single_choice':
    case 'multiple_choice':
      return { ...base, rows: [row(1, true), row(2)] };
    case 'ordering':
    case 'matching':
      return { ...base, shuffle: true, rows: [row(1), row(2)] };
    default:
      return base;
  }
}

export const blankExercise = (): DraftExercise => ({
  loadProblems: [],
  steps: [blankStep('single_choice', [])],
  points: '',
  hintPolicy: 'free',
});

const rowsOf = (list: { id: string; label: string }[], extra = (_: string) => ''): Row[] =>
  list.map((o) => ({ id: o.id, label: o.label, extra: extra(o.id), correct: false }));

/**
 * Loads stored content into the form. Content that is not valid `exercise.v1` starts blank,
 * with `loadProblems` saying why, so the author sees that saving replaces a definition.
 */
export function toDraft(content: unknown): DraftExercise {
  const parsed = exerciseV1.safeParse(content);
  if (!parsed.success) {
    const problems = content === undefined || content === null ? [] : exerciseProblems(content);
    return { ...blankExercise(), loadProblems: problems };
  }
  const { steps, credit } = parsed.data;
  return {
    loadProblems: [],
    points: credit ? String(credit.points) : '',
    hintPolicy: credit?.hintPolicy ?? 'free',
    steps: steps.map((step) => {
      const draft: DraftStep = {
        ...blankStep(step.kind, []),
        id: step.id,
        title: step.title,
        prompt: step.prompt,
        hints: step.hints,
        solution: step.solution ?? '',
      };
      switch (step.kind) {
        case 'numeric':
          return {
            ...draft,
            answer: String(step.answer),
            tolerance: String(step.tolerance),
            unit: step.unit ?? '',
            correct: step.feedback.correct,
            incorrect: step.feedback.incorrect,
            low: step.feedback.low ?? '',
            high: step.feedback.high ?? '',
          };
        case 'single_choice':
        case 'multiple_choice': {
          const right = step.kind === 'single_choice' ? [step.correct] : step.correct;
          return {
            ...draft,
            shuffle: step.shuffle,
            correct: step.feedback.correct,
            incorrect: step.feedback.incorrect,
            rows: step.options.map((o) => ({
              id: o.id,
              label: o.label,
              extra: o.feedback ?? '',
              correct: right.includes(o.id),
            })),
          };
        }
        case 'ordering': {
          const byId = new Map(step.items.map((i) => [i.id, i]));
          const ordered = step.order.flatMap((id) => byId.get(id) ?? []);
          return {
            ...draft,
            shuffle: step.shuffle,
            correct: step.feedback.correct,
            incorrect: step.feedback.incorrect,
            rows: rowsOf(ordered),
          };
        }
        case 'matching': {
          const choices = new Map(step.choices.map((c) => [c.id, c.label]));
          return {
            ...draft,
            shuffle: step.shuffle,
            correct: step.feedback.correct,
            incorrect: step.feedback.incorrect,
            rows: step.prompts.map((p) => ({
              id: p.id,
              label: p.label,
              extra: choices.get(step.pairs[p.id] ?? '') ?? '',
              correct: false,
              choiceId: step.pairs[p.id] ?? '',
            })),
            distractors: rowsOf(
              step.choices.filter((c) => !Object.values(step.pairs).includes(c.id)),
            ),
          };
        }
        case 'text':
          return { ...draft, maxLength: String(step.maxLength), saved: step.feedback.saved };
        case 'simulation':
          return {
            ...draft,
            controlName: step.control.name,
            controlLabel: step.control.label,
            min: String(step.control.min),
            max: String(step.control.max),
            stepSize: String(step.control.step),
            initial: String(step.control.initial),
            compare: step.compare.join(', '),
            correct: step.feedback.correct,
            incomplete: step.feedback.incomplete,
            rows: step.observations.map((o) => ({
              id: o.id,
              label: o.label,
              extra: o.unit ?? '',
              correct: false,
            })),
          };
        default:
          return {
            ...draft,
            language: step.language,
            starter: step.starter,
            saved: step.feedback.saved,
          };
      }
    }),
  };
}

const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
const labelled = (rows: Row[]) => rows.map((r) => ({ id: r.id, label: text(r.label) }));

function stepContent(s: DraftStep): unknown {
  const common = {
    id: s.id,
    kind: s.kind,
    title: text(s.title),
    prompt: text(s.prompt),
    hints: s.hints.map(text),
    ...optional('solution', s.solution),
  };
  const right = { correct: text(s.correct), incorrect: text(s.incorrect) };
  switch (s.kind) {
    case 'numeric':
      return {
        ...common,
        answer: num(s.answer),
        tolerance: num(s.tolerance),
        ...optional('unit', s.unit),
        feedback: { ...right, ...optional('low', s.low), ...optional('high', s.high) },
      };
    case 'single_choice':
    case 'multiple_choice': {
      const chosen = s.rows.filter((r) => r.correct).map((r) => r.id);
      return {
        ...common,
        options: s.rows.map((r) => ({
          id: r.id,
          label: text(r.label),
          ...optional('feedback', r.extra),
        })),
        correct: s.kind === 'single_choice' ? (chosen[0] ?? '') : chosen,
        shuffle: s.shuffle,
        feedback: right,
      };
    }
    case 'ordering':
      return {
        ...common,
        items: labelled(s.rows),
        order: s.rows.map((r) => r.id),
        shuffle: s.shuffle,
        feedback: right,
      };
    case 'matching': {
      // Paired choices keep their stored ids; a prompt whose choice label was edited apart
      // from another prompt sharing it gets its own choice. Distractors follow, unpaired.
      const reserved = new Set([
        ...s.rows.map((r) => r.choiceId ?? ''),
        ...s.distractors.map((d) => d.id),
      ]);
      const choices: { id: string; label: string }[] = [];
      const pairs: Record<string, string> = {};
      for (const r of s.rows) {
        const label = text(r.extra);
        let choice = choices.find((c) => c.id === r.choiceId && c.label === label);
        if (!choice) {
          let id = r.choiceId ?? '';
          if (!id || choices.some((c) => c.id === id)) {
            id = nextId('c', [...reserved, ...choices.map((c) => c.id)]);
            reserved.add(id);
          }
          choice = { id, label };
          choices.push(choice);
        }
        pairs[r.id] = choice.id;
      }
      choices.push(...labelled(s.distractors));
      return {
        ...common,
        prompts: labelled(s.rows),
        choices,
        pairs,
        shuffle: s.shuffle,
        feedback: right,
      };
    }
    case 'text':
      return {
        ...common,
        maxLength: num(s.maxLength),
        feedback: { saved: text(s.saved) },
      };
    case 'simulation':
      return {
        ...common,
        control: {
          name: text(s.controlName),
          label: text(s.controlLabel),
          min: num(s.min),
          max: num(s.max),
          step: num(s.stepSize),
          initial: num(s.initial),
        },
        observations: s.rows.map((r) => ({
          id: r.id,
          label: text(r.label),
          ...optional('unit', r.extra),
        })),
        compare: s.compare
          .split(',')
          .filter((v) => v.trim() !== '')
          .map(num),
        feedback: { correct: text(s.correct), incomplete: text(s.incomplete) },
      };
    case 'code':
      return {
        ...common,
        language: s.language,
        starter: s.starter,
        feedback: { saved: text(s.saved) },
      };
  }
}

export function toContent(draft: DraftExercise): unknown {
  const points = num(draft.points);
  return {
    schema: 'exercise.v1',
    steps: draft.steps.map(stepContent),
    ...(draft.points.trim() !== '' && {
      credit: { points, hintPolicy: draft.hintPolicy },
    }),
  };
}

/** What still stops the form from being a valid exercise; empty when it can be saved. */
export const problemsOf = (draft: DraftExercise): string[] => exerciseProblems(toContent(draft));

export type { ExerciseV1 };
