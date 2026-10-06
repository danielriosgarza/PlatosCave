import { testV1 } from '@parallax/contracts';
import { describe, expect, it } from 'vitest';
import {
  blankCheck,
  blankFile,
  blankQuestion,
  blankTest,
  checksAfterFileChange,
  problemsOf,
  toContent,
  toDraft,
  withKind,
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
  const [a, b, data] = [blankFile('a.py'), blankFile('b.py'), blankFile('data.csv')];
  const files = [a, b, data];
  const checks = [
    { ...blankCheck('a.py', a.uid), name: 'one', files: 'data.csv\nb.py' },
    { ...blankCheck('b.py', b.uid), name: 'two' },
  ];
  it('follows a renamed file and drops a removed one', () => {
    expect(checksAfterFileChange(checks, b, 'c.py', files).map((c) => [c.file, c.files])).toEqual([
      ['a.py', 'data.csv\nc.py'],
      ['c.py', ''],
    ]);
    expect(checksAfterFileChange(checks, data, undefined, files)[0]?.files).toBe('b.py');
    expect(checksAfterFileChange(checks, a, undefined, files)[0]?.file).toBe('');
  });

  it('keeps the checks on their file while its path is cleared and retyped beside a new file', () => {
    // File 1 holds the checks; a new file has the path ''. Clearing file 1, then typing, must not
    // hand its checks to the new file.
    const first = blankFile('solution.py');
    const added = blankFile('');
    let list = [first, added];
    let current = [{ ...blankCheck('solution.py', first.uid), name: 'one' }];
    for (const path of ['solution.p', '', 'm', 'ma', 'main.py']) {
      current = checksAfterFileChange(current, list[0] as typeof first, path, list);
      list = [{ ...first, path }, added];
    }
    expect(current[0]?.file).toBe('main.py');
    // The new file gets a path: the checks stay with file 1.
    current = checksAfterFileChange(current, added, 'other.py', list);
    expect(current[0]?.file).toBe('main.py');
  });
});

describe('correct options', () => {
  it('stay on their option while its id is retyped through a duplicate', () => {
    const question = blankQuestion('choice', 'q1');
    const [first, second] = question.options;
    if (!first || !second) throw new Error('blank options');
    // Options a and ab; ab is correct. Retyping ab: ab -> a (a duplicate) -> ac.
    let draft = { ...question, options: [first, { ...second, id: 'ab' }], correct: [second.uid] };
    for (const id of ['a', 'ac']) {
      draft = { ...draft, options: [first, { ...second, id }] };
    }
    const built = toContent({ ...blankTest(), questions: [draft] });
    if (!('content' in built)) throw new Error(built.problem);
    const sent = (built.content as { questions: { correct: string[] }[] }).questions[0];
    expect(sent?.correct).toEqual(['ac']);
  });

  it('are read from and written back as ids', () => {
    const draft = toDraft(stored);
    const choice = draft.questions[0];
    expect(choice?.correct).toEqual([choice?.options[1]?.uid]);
    const built = toContent(draft);
    if (!('content' in built)) throw new Error(built.problem);
    const sent = (built.content as { questions: { options: object[]; correct: string[] }[] })
      .questions[0];
    expect(sent?.correct).toEqual(['b']);
    expect(sent?.options).toEqual([
      { id: 'a', label: 'n = 10' },
      { id: 'b', label: 'n = 100' },
    ]);
  });
});

describe('stdin of a check', () => {
  const sent = (c: ReturnType<typeof blankCheck>) => {
    const built = toContent({
      ...blankTest(),
      questions: [
        { ...blankQuestion('code', 'q1'), checks: [{ ...c, fn: 'f', expectedValue: '1' }] },
      ],
    });
    if (!('content' in built)) throw new Error(built.problem);
    const check = (built.content as { questions: { checks: Record<string, unknown>[] }[] })
      .questions[0]?.checks[0];
    return check?.stdin;
  };
  it('is cleared when the kind changes away from stdio', () => {
    const typed = { ...blankCheck('solution.py'), kind: 'stdio' as const, stdin: '1 2\n' };
    expect(sent(typed)).toBe('1 2\n');
    expect(sent(withKind(typed, 'call'))).toBeUndefined();
    expect(sent(withKind(typed, 'script'))).toBeUndefined();
    expect(withKind(typed, 'stdio').stdin).toBe('1 2\n');
  });
  it('is kept on a script or call check that was stored with one', () => {
    const draft = toDraftCheckOf({ kind: 'script', stdin: 'x', file: 'a.py', name: 's' });
    expect(sent(draft)).toBe('x');
  });
});

function toDraftCheckOf(check: Record<string, unknown>) {
  const draft = toDraft({
    questions: [
      {
        id: 'q1',
        kind: 'code',
        prompt: 'p',
        points: 1,
        runtime: 'python-3.12',
        files: [{ path: 'a.py', content: '', editable: true, hidden: false }],
        allowedPackages: [],
        checks: [{ visibility: 'public', points: 1, ...check }],
      },
    ],
  });
  return draft.questions[0]?.checks[0] as ReturnType<typeof blankCheck>;
}
