import { exerciseV1 } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import {
  blankExercise,
  blankStep,
  presentedAsAnswer,
  problemsOf,
  toContent,
  toDraft,
} from './exerciseForm';

const reference = exerciseV1.parse({
  schema: 'exercise.v1',
  credit: { points: 10, hintPolicy: 'reduces_credit' },
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'How does the spread change?',
      options: [
        { id: 'wider', label: 'Wider' },
        { id: 'narrower', label: 'Narrower', feedback: 'Averaging reduces noise.' },
      ],
      correct: 'narrower',
      shuffle: true,
      hints: ['Think about averaging.'],
      solution: 'Narrower.',
      feedback: { correct: 'Yes.', incorrect: 'No.' },
    },
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare n = 100 with n = 25.',
      control: { name: 'n', label: 'Sample size', min: 5, max: 200, step: 5, initial: 25 },
      observations: [{ id: 'sd', label: 'SD', unit: 'units' }],
      compare: [25, 100],
      feedback: { correct: 'Both.', incomplete: 'Compare with 100.' },
    },
    {
      id: 'order',
      kind: 'ordering',
      title: 'Order',
      prompt: 'Order them.',
      items: [
        { id: 'a', label: 'First' },
        { id: 'b', label: 'Second' },
      ],
      order: ['b', 'a'],
      shuffle: true,
      feedback: { correct: 'Yes.', incorrect: 'No.' },
    },
    {
      id: 'match',
      kind: 'matching',
      title: 'Match',
      prompt: 'Match.',
      prompts: [
        { id: 'p1', label: 'Mean' },
        { id: 'p2', label: 'Median' },
      ],
      choices: [
        { id: 'c1', label: 'Average' },
        { id: 'c2', label: 'Middle' },
        { id: 'c3', label: 'Spread' },
        { id: 'c4', label: 'Average' },
      ],
      pairs: { p1: 'c1', p2: 'c2' },
      shuffle: true,
      feedback: { correct: 'Yes.', incorrect: 'No.' },
    },
    {
      id: 'number',
      kind: 'numeric',
      title: 'Number',
      prompt: 'SE?',
      answer: 5,
      tolerance: 0.5,
      unit: 'kg',
      feedback: { correct: 'Yes.', incorrect: 'No.', low: 'Higher.' },
    },
    {
      id: 'explain',
      kind: 'text',
      title: 'Explain',
      prompt: 'Why?',
      maxLength: 500,
      feedback: { saved: 'Saved.' },
    },
    {
      id: 'code',
      kind: 'code',
      title: 'Code',
      prompt: 'Write it.',
      language: 'r',
      starter: 'x <- 1',
      feedback: { saved: 'Saved.' },
    },
  ],
});

describe('exercise form', () => {
  it('round-trips every step kind, keeping ids and credit', () => {
    expect(exerciseV1.parse(toContent(toDraft(reference)))).toEqual(reference);
  });

  it('keeps unpaired matching choices, even one that shares a label with a paired choice', () => {
    const draft = toDraft(reference);
    const match = exerciseV1.parse(toContent(draft)).steps.find((s) => s.kind === 'matching');
    expect(match?.kind === 'matching' && match.choices.map((c) => c.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
  });

  it('prompts added in the editor that name the same choice share one choice', () => {
    const draft = toDraft(reference);
    const row = (id: string, label: string, extra: string) => ({
      id,
      label,
      extra,
      correct: false,
    });
    const steps = draft.steps.map((s) =>
      s.kind === 'matching'
        ? {
            ...s,
            distractors: [],
            rows: [
              row('o1', 'Dog', 'Mammal'),
              row('o2', 'Cat', 'Mammal'),
              row('o3', 'Eagle', 'Bird'),
            ],
          }
        : s,
    );
    const match = exerciseV1
      .parse(toContent({ ...draft, steps }))
      .steps.find((s) => s.kind === 'matching');
    if (match?.kind !== 'matching') throw new Error('no matching step');
    expect(match.choices.map((c) => c.label)).toEqual(['Mammal', 'Bird']);
    expect(match.pairs.o1).toBe(match.pairs.o2);
    expect(match.pairs.o1).not.toBe(match.pairs.o3);
  });

  it('a prompt added with the label of an extra choice adopts it instead of duplicating it', () => {
    const draft = toDraft(reference);
    const steps = draft.steps.map((s) =>
      s.kind === 'matching'
        ? {
            ...s,
            rows: [...s.rows, { id: 'o9', label: 'Range', extra: 'Spread', correct: false }],
          }
        : s,
    );
    const match = exerciseV1
      .parse(toContent({ ...draft, steps }))
      .steps.find((s) => s.kind === 'matching');
    if (match?.kind !== 'matching') throw new Error('no matching step');
    expect(match.choices.filter((c) => c.label === 'Spread')).toHaveLength(1);
    expect(match.pairs.o9).toBe('c3');
    expect(match.choices.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('an ordering step created in the editor is shuffled and stores no presentation order', () => {
    const step = blankStep('ordering', []);
    expect(step.shuffle).toBe(true);
    expect(step.presented).toEqual([]);
  });

  it('tells whether an unshuffled ordering step shows the answer order', () => {
    const ordering = toDraft(reference).steps.find((s) => s.kind === 'ordering');
    if (!ordering) throw new Error('no ordering step');
    expect(presentedAsAnswer(ordering)).toBe(false);
    expect(presentedAsAnswer({ ...ordering, presented: ['b', 'a'] })).toBe(true);
  });

  it('keeps an ordering step’s stored presentation order apart from the answer order', () => {
    const step = exerciseV1
      .parse(toContent(toDraft(reference)))
      .steps.find((s) => s.kind === 'ordering');
    expect(step?.kind === 'ordering' && step.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(step?.kind === 'ordering' && step.order).toEqual(['b', 'a']);
  });

  it('says why stored content could not be loaded, and nothing for a new exercise', () => {
    expect(toDraft({ schema: 'exercise.v1', steps: [] }).loadProblems.length).toBeGreaterThan(0);
    expect(toDraft(undefined).loadProblems).toEqual([]);
  });

  it('a new blank step is not valid until its prompt, options and feedback are written', () => {
    expect(problemsOf(blankExercise()).length).toBeGreaterThan(0);
  });

  it('reports an off-grid compare value in the author’s terms', () => {
    const draft = toDraft(reference);
    const sim = draft.steps.map((s) =>
      s.kind === 'simulation' ? { ...s, compare: '25, 102' } : s,
    );
    expect(problemsOf({ ...draft, steps: sim })).toEqual([
      expect.stringContaining('Step 2 “Inspect”: compare values must be'),
    ]);
  });

  it('empty points means ungraded practice, with no credit stored', () => {
    const draft = { ...toDraft(reference), points: '' };
    expect(exerciseV1.parse(toContent(draft)).credit).toBeUndefined();
  });

  it('generates step ids that do not collide', () => {
    expect(blankStep('text', ['step1', 'step2']).id).toBe('step3');
  });
});
