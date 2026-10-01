import { type ExerciseStep, exerciseStep, exerciseV1 } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import { judge, parseResponse, seededShuffle, viewStep } from './evaluate';

const step = (raw: Record<string, unknown>): ExerciseStep =>
  exerciseStep.parse({ id: 's', title: 'Step', prompt: 'Answer.', ...raw });
const feedback = { correct: 'Right.', incorrect: 'Not quite.' };

const numeric = step({
  kind: 'numeric',
  answer: 2.5,
  tolerance: 0.1,
  feedback: { ...feedback, low: 'Too small: the SE halves.' },
});
const single = step({
  kind: 'single_choice',
  options: [
    { id: 'wider', label: 'Wider', feedback: 'Larger samples average out more noise.' },
    { id: 'same', label: 'About the same' },
    { id: 'narrower', label: 'Narrower' },
  ],
  correct: 'narrower',
  shuffle: true,
  hints: ['Think about averaging.'],
  solution: 'Narrower: the SE is σ/√n.',
  feedback,
});

describe('exercise.v1', () => {
  it('A08 accepts the reference exercise and rejects inconsistent keys', () => {
    const steps = [
      single,
      {
        id: 'explain',
        kind: 'text',
        title: 'Explain',
        prompt: 'Why?',
        feedback: { saved: 'Saved.' },
      },
    ];
    expect(exerciseV1.safeParse({ schema: 'exercise.v1', steps }).success).toBe(true);
    const bad = [{ ...single, correct: 'missing' }];
    expect(exerciseV1.safeParse({ schema: 'exercise.v1', steps: bad }).success).toBe(false);
    const twice = [single, single];
    expect(exerciseV1.safeParse({ schema: 'exercise.v1', steps: twice }).success).toBe(false);
    const order = step({
      kind: 'ordering',
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      order: ['a', 'a'],
      feedback,
    });
    expect(exerciseV1.safeParse({ schema: 'exercise.v1', steps: [order] }).success).toBe(false);
  });
});

describe('judging', () => {
  it('A08 numeric answers use the tolerance and targeted feedback', () => {
    expect(judge(numeric, 2.58)).toEqual({ correct: true, feedback: 'Right.' });
    expect(judge(numeric, 1.25)).toEqual({ correct: false, feedback: 'Too small: the SE halves.' });
    expect(judge(numeric, 5)).toEqual({ correct: false, feedback: 'Not quite.' });
    expect(parseResponse(numeric, '2.5').ok).toBe(false);
  });

  it('A08 a wrong choice returns that option’s feedback', () => {
    expect(judge(single, 'wider')).toEqual({
      correct: false,
      feedback: 'Larger samples average out more noise.',
    });
    expect(judge(single, 'same').feedback).toBe('Not quite.');
    expect(judge(single, 'narrower').correct).toBe(true);
    expect(parseResponse(single, 'bogus').ok).toBe(false);
  });

  it('A08 multiple choice, ordering and matching judge the whole response', () => {
    const multi = step({
      kind: 'multiple_choice',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', feedback: 'B is a distractor.' },
        { id: 'c', label: 'C' },
      ],
      correct: ['a', 'c'],
      feedback,
    });
    expect(judge(multi, ['c', 'a']).correct).toBe(true);
    expect(judge(multi, ['a', 'b'])).toEqual({ correct: false, feedback: 'B is a distractor.' });
    expect(parseResponse(multi, ['a', 'a']).ok).toBe(false);

    const order = step({
      kind: 'ordering',
      items: [
        { id: 'draw', label: 'Draw a sample' },
        { id: 'mean', label: 'Compute its mean' },
        { id: 'repeat', label: 'Repeat' },
      ],
      order: ['draw', 'mean', 'repeat'],
      feedback,
    });
    expect(judge(order, ['draw', 'mean', 'repeat']).correct).toBe(true);
    expect(judge(order, ['mean', 'draw', 'repeat']).correct).toBe(false);
    expect(parseResponse(order, ['draw', 'mean']).ok).toBe(false);

    const match = step({
      kind: 'matching',
      prompts: [
        { id: 'n25', label: 'n = 25' },
        { id: 'n100', label: 'n = 100' },
      ],
      choices: [
        { id: 'wide', label: 'SE 2' },
        { id: 'narrow', label: 'SE 1' },
      ],
      pairs: { n25: 'wide', n100: 'narrow' },
      feedback,
    });
    expect(judge(match, { n25: 'wide', n100: 'narrow' }).correct).toBe(true);
    expect(judge(match, { n25: 'narrow', n100: 'wide' }).correct).toBe(false);
    expect(parseResponse(match, { n25: 'wide' }).ok).toBe(false);
  });

  it('A08 a simulation accepts only grid values and declared observations', () => {
    const sim = step({
      kind: 'simulation',
      control: { name: 'n', label: 'Sample size', min: 5, max: 200, step: 5, initial: 25 },
      observations: [{ id: 'sd', label: 'SD of sample means' }],
      compare: [25, 100],
      feedback: { correct: 'Compared.', incomplete: 'Now try n = 100.' },
    });
    expect(parseResponse(sim, { value: 100, observations: { sd: 1 } }).ok).toBe(true);
    expect(parseResponse(sim, { value: 102 }).ok).toBe(false);
    expect(parseResponse(sim, { value: 100, observations: { pointer: 3 } }).ok).toBe(false);
    expect(judge(sim, { value: 25 })).toEqual({ correct: false, feedback: 'Now try n = 100.' });
    expect(judge(sim, { value: 100 }, [25])).toEqual({ correct: true, feedback: 'Compared.' });
  });

  it('A23 an empty or whitespace explanation is refused', () => {
    const text = step({ kind: 'text', feedback: { saved: 'Saved.' } });
    expect(parseResponse(text, '  \n ').ok).toBe(false);
    expect(parseResponse(text, '').ok).toBe(false);
    expect(parseResponse(text, 'Averages vary less.').ok).toBe(true);
  });
});

describe('seeded order', () => {
  it('replays the same order for the same seed and hides the key', () => {
    const ids = (seed: number) => viewStep(single, seed).options?.map((o) => o.id);
    expect(ids(7)).toEqual(ids(7));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => ids(s)?.join()))).not.toEqual(
      new Set([ids(1)?.join()]),
    );
    expect(seededShuffle([1, 2, 3], 9, 'x').sort()).toEqual([1, 2, 3]);
    const view = JSON.stringify(viewStep(single, 1));
    expect(view).not.toContain('Narrower: the SE');
    expect(view).not.toContain('Larger samples');
    expect(view).not.toContain('"correct"');
  });
});
