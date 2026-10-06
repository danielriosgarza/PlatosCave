import { describe, expect, test } from 'vitest';
import type { RunnerRuntime } from '../config';
import { testPublicationIssues } from './publication';

const runtimes: RunnerRuntime[] = [
  {
    id: 'python-3.12',
    language: 'python',
    image: 'parallax-runner-python:dev',
    digest: null,
    harnessVersion: '1',
    packages: ['numpy', 'pandas'],
  },
];

const sample = {
  name: 'sample',
  kind: 'call',
  visibility: 'public',
  file: 'solution.py',
  function: 'mean',
  args: [[1, 2, 3]],
  expected: { value: 2 },
  compare: { mode: 'numeric' },
};
const hiddenCall = { ...sample, name: 'large', visibility: 'hidden', args: [[40, 44]] };
const hiddenScript = {
  name: 'hidden-script',
  kind: 'script',
  visibility: 'hidden',
  file: 'tests/check.py',
  files: ['solution.py'],
};
const files = [
  { path: 'solution.py', content: 'def mean(xs):\n    pass\n', editable: true, hidden: false },
  { path: 'tests/check.py', content: 'print(1)\n', editable: false, hidden: true },
];

const test1 = (code: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  questions: [
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
      runtime: 'python-3.12',
      files,
      checks: [sample, hiddenCall],
      ...code,
    },
  ],
  ...extra,
});

const messages = (content: unknown) =>
  testPublicationIssues(content, runtimes).errors.map((e) => e.message);

describe('test publication validation (design §8.1)', () => {
  test('a well-formed test has no errors and no warnings', () => {
    expect(testPublicationIssues(test1({}), runtimes)).toEqual({ errors: [], warnings: [] });
  });

  test('publication warns on script-only hidden checks', () => {
    const found = testPublicationIssues(test1({ checks: [sample, hiddenScript] }), runtimes);
    expect(found.errors).toEqual([]);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toMatchObject({ code: 'script_only_hidden_checks' });
    // The warning states the condition and the action, not the design behind it.
    expect(found.warnings[0]?.message).toBe(
      'Question “mean”: every hidden check is a script check. Add a call or stdio hidden check.',
    );
  });

  test('a script check beside a call check, or no hidden check at all, does not warn', () => {
    expect(
      testPublicationIssues(test1({ checks: [sample, hiddenScript, hiddenCall] }), runtimes)
        .warnings,
    ).toEqual([]);
    expect(testPublicationIssues(test1({ checks: [sample] }), runtimes).warnings).toEqual([]);
  });

  test('an unknown runtime and a package outside the runtime are rejected', () => {
    expect(messages(test1({ runtime: 'python-3.99' }))).toEqual([
      expect.stringContaining('runtime python-3.99 is not offered'),
    ]);
    expect(messages(test1({ allowedPackages: ['numpy', 'torch'] }))).toEqual([
      expect.stringContaining('package torch is not available in python-3.12'),
    ]);
  });

  test('limits outside the server bounds are rejected', () => {
    expect(messages(test1({ limits: { wallSeconds: 61 } })).join()).toMatch(/wallSeconds/);
    expect(messages(test1({ limits: { memoryMiB: 63 } })).join()).toMatch(/memoryMiB/);
    expect(messages(test1({ limits: { outputBytes: 5 * 1024 * 1024 } })).join()).toMatch(
      /outputBytes/,
    );
  });

  test('duplicate check names and a missing public check are rejected', () => {
    expect(messages(test1({ checks: [sample, { ...hiddenCall, name: 'sample' }] }))).toEqual([
      expect.stringContaining('duplicate check name sample'),
    ]);
    expect(messages(test1({ checks: [hiddenCall] }))).toEqual([
      expect.stringContaining('needs at least one public (sample) check'),
    ]);
  });

  test('a check naming a file that is not in files, or a public check naming a hidden file', () => {
    expect(messages(test1({ checks: [{ ...sample, file: 'missing.py' }] }))).toEqual([
      expect.stringContaining('check sample names missing.py, which is not in files'),
    ]);
    expect(messages(test1({ checks: [{ ...sample, files: ['tests/check.py'] }] }))).toEqual([
      expect.stringContaining('public check sample names hidden file tests/check.py'),
    ]);
  });

  test('a file path that is a directory prefix of another is rejected', () => {
    const nested = [
      ...files,
      { path: 'data', content: 'x', editable: false, hidden: false },
      { path: 'data/sample.csv', content: '1', editable: false, hidden: false },
    ];
    expect(messages(test1({ files: nested }))).toEqual([
      expect.stringContaining('file path data is a directory prefix of data/sample.csv'),
    ]);
  });

  test('a file that is both editable and hidden is rejected', () => {
    const both = [{ ...files[0], hidden: true }, { ...files[0], path: 'b.py' }, files[1]];
    // The public check that names the now-hidden file is reported as well.
    expect(messages(test1({ files: both }))[0]).toMatch(/solution\.py is both editable and hidden/);
  });

  test('a hidden check whose files do not form a valid job is rejected', () => {
    const broken = [
      files[0],
      { path: 'tests/check.py', content: '!!!', encoding: 'base64', editable: false, hidden: true },
    ];
    const found = messages(test1({ files: broken, checks: [sample, { ...hiddenScript }] }));
    expect(found).toEqual([expect.stringContaining('do not form a valid job')]);
    expect(found[0]).toMatch(/not valid base64/);
  });

  test('a rubric worth more than the question and impossible settings are rejected', () => {
    const rubric = [
      { id: 'a', label: 'Reasoning', points: 3 },
      { id: 'b', label: 'Clarity', points: 2 },
    ];
    expect(messages(test1({ rubric }))).toEqual([
      expect.stringContaining('rubric criteria add up to 5, more than the question’s 4 points'),
    ]);
    expect(
      messages(
        test1(
          {},
          { settings: { opensAt: '2026-10-02T00:00:00Z', closesAt: '2026-10-01T00:00:00Z' } },
        ),
      ),
    ).toEqual([expect.stringContaining('closing time must be after the opening time')]);
  });

  test('a rubric that adds up to the question’s decimal points is accepted', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as floats.
    const rubric = [
      { id: 'a', label: 'Reasoning', points: 0.1 },
      { id: 'b', label: 'Clarity', points: 0.2 },
    ];
    expect(messages(test1({ rubric, points: 0.3 }))).toEqual([]);
    const over = [...rubric, { id: 'c', label: 'Depth', points: 0.01 }];
    expect(messages(test1({ rubric: over, points: 0.3 }))).toEqual([
      expect.stringContaining('add up to 0.31, more than the question’s 0.3 points'),
    ]);
  });

  test('a rubric that exceeds the points by fractions of a hundredth is rejected', () => {
    const third = (id: string) => ({ id, label: id, points: 0.333 });
    expect(messages(test1({ rubric: [third('a'), third('b'), third('c')], points: 0.99 }))).toEqual(
      [expect.stringContaining('more than the question’s 0.99 points')],
    );
    const tiny = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: 'x', points: 0.004 }));
    expect(messages(test1({ rubric: tiny, points: 0.01 }))).toEqual([
      expect.stringContaining('more than the question’s 0.01 points'),
    ]);
  });

  test('two rubric criteria of one question with the same id are rejected', () => {
    const rubric = [
      { id: 'c2', label: 'Reasoning', points: 1 },
      { id: 'c2', label: 'Clarity', points: 1 },
    ];
    expect(messages(test1({ rubric }))).toEqual([
      expect.stringContaining('duplicate criterion id'),
    ]);
  });

  test('content that is not test.v1 is reported as an error, never thrown', () => {
    expect(messages({ questions: [] })[0]).toMatch(/questions/);
    expect(messages('nope')).toHaveLength(1);
  });
});
