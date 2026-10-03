import { describe, expect, test } from 'vitest';
import { exerciseProblems, exerciseV1 } from './exercise';

const fb = { correct: 'Yes.', incomplete: 'Not yet.' };
const simulation = (control: object, compare: number[]) => ({
  schema: 'exercise.v1',
  steps: [
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare the two.',
      control: {
        name: 'n',
        label: 'Sample size',
        min: 5,
        max: 200,
        step: 5,
        initial: 25,
        ...control,
      },
      observations: [],
      compare,
      feedback: fb,
    },
  ],
});

describe('exercise.v1 authoring rules', () => {
  test('a simulation whose initial and compare values lie on the control grid is valid', () => {
    expect(exerciseProblems(simulation({}, [25, 100]))).toEqual([]);
  });

  test('an off-grid compare value is refused, because the step could never complete', () => {
    const problems = exerciseProblems(simulation({}, [25, 102]));
    expect(problems).toEqual([expect.stringMatching(/Step 1 “Inspect”: compare values must be/)]);
  });

  test('an off-grid initial value is refused', () => {
    expect(exerciseProblems(simulation({ initial: 27 }, [25]))).toEqual([
      expect.stringMatching(/initial value must be one the control offers/),
    ]);
  });

  test('fractional steps are tolerated when the value is on the grid', () => {
    expect(
      exerciseProblems(simulation({ min: 0, max: 1, step: 0.1, initial: 0.3 }, [0.3, 0.7])),
    ).toEqual([]);
  });

  test('credit is optional; points must be positive and the hint policy known', () => {
    const base = simulation({}, [25]);
    expect(exerciseV1.safeParse(base).success).toBe(true);
    const credit = (c: object) => exerciseV1.safeParse({ ...base, credit: c }).success;
    expect(credit({ points: 10, hintPolicy: 'reduces_credit' })).toBe(true);
    expect(credit({ points: 0, hintPolicy: 'free' })).toBe(false);
    expect(credit({ points: 10, hintPolicy: 'whenever' })).toBe(false);
  });

  test('problems name the step by position and title', () => {
    const content = {
      schema: 'exercise.v1',
      steps: [{ id: 'a', kind: 'text', title: 'Explain', prompt: '', feedback: { saved: 'ok' } }],
    };
    expect(exerciseProblems(content)).toEqual([
      expect.stringContaining('Step 1 “Explain” · prompt'),
    ]);
  });

  test('common mistakes are reported in author words, not validator text', () => {
    const choice = (patch: object) => ({
      schema: 'exercise.v1',
      steps: [
        {
          id: 'pick',
          kind: 'single_choice',
          title: 'Pick',
          prompt: 'Which?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          correct: 'a',
          feedback: { correct: 'Yes.', incorrect: 'No.' },
          ...patch,
        },
      ],
    });
    expect(exerciseProblems(choice({ correct: '' }))).toEqual([
      'Step 1 “Pick”: tick a correct option',
    ]);
    expect(exerciseProblems(choice({ title: '' }))).toEqual(['Step 1 · title: must not be empty']);
    const sim = simulation({}, [Number.NaN]);
    expect(exerciseProblems(sim)).toEqual([
      'Step 1 “Inspect” · compare · #1: values must be numbers',
    ]);
    expect(exerciseProblems(choice({ options: [] }))).toContain(
      'Step 1 “Pick” · options: needs at least 2',
    );
  });

  test('exclusive minimums and the id rule are worded as they are enforced', () => {
    expect(exerciseProblems(simulation({ step: 0 }, [25]))).toContain(
      'Step 1 “Inspect” · control · step: must be greater than 0',
    );
    for (const name of ['_x', 'x'.repeat(41)]) {
      expect(exerciseProblems(simulation({ name }, [25]))).toEqual([
        expect.stringMatching(/control · name: must start with a lowercase letter or digit/),
      ]);
    }
  });
});
