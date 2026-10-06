import { testV1 } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import {
  blankCheck,
  blankQuestion,
  blankTest,
  checksAfterFileChange,
  problemsOf,
  toContent,
  toDraft,
} from './testForm';

const stored = testV1.parse({
  questions: [
    {
      id: 'pick',
      kind: 'choice',
      prompt: 'Which varies least?',
      points: 1,
      options: [
        { id: 'a', label: 'n = 10' },
        { id: 'b', label: 'n = 100' },
      ],
      correct: ['b'],
      rubric: [{ id: 'why', label: 'Gives a reason', points: 1 }],
    },
    {
      id: 'se',
      kind: 'numeric',
      prompt: 'SE for sd 3, n 9?',
      points: 2,
      answer: 1,
      tolerance: 0.01,
      unit: 'units',
    },
    {
      id: 'run',
      kind: 'code',
      prompt: 'Read numbers; print their sum.',
      points: 4,
      runtime: 'python-3.12',
      allowedPackages: ['numpy'],
      limits: { wallSeconds: 20 },
      files: [
        { path: 'main.py', content: 'print(0)\n', editable: true, hidden: false },
        { path: 'tests/check.py', content: 'x = 1\n', editable: false, hidden: true },
      ],
      checks: [
        {
          name: 'sum',
          kind: 'stdio',
          visibility: 'public',
          file: 'main.py',
          stdin: '1 2\n',
          expected: { stdout: '3\n', exitCode: 0 },
          compare: { mode: 'tokens' },
          points: 1,
        },
        {
          name: 'raises',
          kind: 'call',
          visibility: 'hidden',
          file: 'main.py',
          function: 'total',
          args: [[]],
          expected: { raises: { type: 'ValueError' } },
          compare: { mode: 'exact' },
          points: 3,
        },
        {
          name: 'own script',
          kind: 'script',
          visibility: 'hidden',
          file: 'tests/check.py',
          files: ['main.py'],
          args: ['--fast'],
          points: 0,
        },
      ],
    },
  ],
  settings: { attempts: 2, durationMinutes: 45, timeZone: 'Europe/Madrid' },
});

describe('test form', () => {
  it('turns stored content into a form and back to the same test', () => {
    const draft = toDraft(stored);
    expect(problemsOf(draft)).toEqual([]);
    const built = toContent(draft);
    if (!('content' in built)) throw new Error(built.problem);
    const again = testV1.parse(built.content);
    expect(again.questions).toEqual(stored.questions);
    expect(again.settings).toMatchObject({
      attempts: 2,
      durationMinutes: 45,
      timeZone: 'Europe/Madrid',
    });
  });

  it('shows the §11 defaults for settings the author never set', () => {
    const draft = blankTest();
    expect(draft.settings).toMatchObject({
      attempts: '1',
      durationMinutes: '',
      late: 'none',
      releaseResults: 'manual',
      solutions: 'never',
      reportedGrade: 'latest',
    });
  });

  it('names the question, check and field of a problem', () => {
    const draft = toDraft(stored);
    const code = draft.questions[2];
    if (!code) throw new Error('no code question');
    const second = code.checks[1];
    if (!second) throw new Error('no second check');
    code.checks[1] = { ...second, name: '' };
    expect(problemsOf(draft).join('\n')).toMatch(/Question 3 \(run\), check 2, name/);
  });

  it('reports JSON that does not parse, and a new question stays unsaved until it is complete', () => {
    const draft = toDraft(stored);
    const code = draft.questions[2];
    if (!code) throw new Error('no code question');
    const second = code.checks[1];
    if (!second) throw new Error('no second check');
    code.checks[1] = { ...second, expectedValue: '', expects: 'value' };
    expect(problemsOf(draft)).toEqual(['Question 3, check 2: needs an expected value']);

    const blank = { ...blankTest(), questions: [blankQuestion('explanation', 'q1')] };
    expect(problemsOf(blank).join('\n')).toMatch(/prompt/);
  });
});

describe('rubric criteria', () => {
  it('rejects two criteria of one question with the same id', () => {
    const draft = toDraft(stored);
    const code = draft.questions[2];
    if (!code) throw new Error('no code question');
    const rubric = [
      { id: 'c1', label: 'Reasoning', points: '1' },
      { id: 'c1', label: 'Clarity', points: '1' },
    ];
    expect(problemsOf({ ...draft, questions: [{ ...code, rubric }] }).join('\n')).toMatch(
      /duplicate criterion id/,
    );
  });
});

describe('checksAfterFileChange', () => {
  const checks = [
    { ...blankCheck('a.py'), name: 'one', files: 'data.csv\nb.py' },
    { ...blankCheck('b.py'), name: 'two' },
  ];
  it('follows a renamed file and drops a removed one', () => {
    expect(checksAfterFileChange(checks, 'b.py', 'c.py').map((c) => [c.file, c.files])).toEqual([
      ['a.py', 'data.csv\nc.py'],
      ['c.py', ''],
    ]);
    expect(checksAfterFileChange(checks, 'data.csv', undefined)[0]?.files).toBe('b.py');
    expect(checksAfterFileChange(checks, 'a.py', undefined)[0]?.file).toBe('');
  });
});
