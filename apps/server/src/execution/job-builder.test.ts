import { codeQuestion, RUNNER_BOUNDS, validateJob } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import type { RunnerRuntime } from '../config';
import { buildRunnerJob, codeHash, graderVersion } from './job-builder';

const runtime: RunnerRuntime = {
  id: 'python-3.12',
  language: 'python',
  image: 'parallax-runner-python:dev',
  digest: null,
  harnessVersion: '1',
  packages: ['numpy'],
};

const question = codeQuestion.parse({
  id: 'mean',
  kind: 'code',
  prompt: 'Write mean(xs).',
  points: 4,
  runtime: 'python-3.12',
  limits: { wallSeconds: 60, memoryMiB: 2048 },
  files: [
    { path: 'solution.py', content: 'def mean(xs):\n    pass\n', editable: true, hidden: false },
    { path: 'data/sample.csv', content: '1,2,3\n', editable: false, hidden: false },
    { path: 'tests/hidden_test.py', content: 'assert True\n', editable: false, hidden: true },
  ],
  checks: [
    {
      name: 'sample',
      kind: 'call',
      visibility: 'public',
      file: 'solution.py',
      function: 'mean',
      args: [[1, 2, 3]],
      expected: { value: 2 },
      compare: { mode: 'numeric' },
      points: 1,
    },
    {
      name: 'hidden-script',
      kind: 'script',
      visibility: 'hidden',
      file: 'tests/hidden_test.py',
      files: ['solution.py'],
      points: 3,
    },
  ],
});

const snapshot = { files: [{ path: 'solution.py', content: 'def mean(xs):\n    return 2\n' }] };
const jobId = '00000000-0000-4000-8000-0000000000aa';

describe('buildRunnerJob (design §8.2)', () => {
  test('A12 a public job overlays the editable file and carries no hidden check, hidden file or points', () => {
    const built = buildRunnerJob(question, snapshot, 'public', jobId, runtime);
    if (!built.ok) throw new Error(built.message);
    const { job } = built;
    expect(job.set).toBe('public');
    expect(job.jobId).toBe(jobId);
    expect(job.files.map((f) => f.path)).toEqual(['solution.py', 'data/sample.csv']);
    expect(job.files[0]?.content).toBe('def mean(xs):\n    return 2\n');
    expect(job.checks.map((c) => c.name)).toEqual(['sample']);
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/hidden_test|hidden-script|"hidden":true|"points"/);
    expect(validateJob(job)).toEqual({ ok: true });
  });

  test('a full job keeps every check and marks hidden files, still without points', () => {
    const built = buildRunnerJob(question, snapshot, 'full', jobId, runtime);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.checks.map((c) => c.name)).toEqual(['sample', 'hidden-script']);
    expect(built.job.files.find((f) => f.path === 'tests/hidden_test.py')?.hidden).toBe(true);
    expect(JSON.stringify(built.job)).not.toMatch(/"points"/);
  });

  test('only editable paths are accepted, once each', () => {
    for (const files of [
      [{ path: 'data/sample.csv', content: 'x' }],
      [{ path: 'tests/hidden_test.py', content: 'x' }],
      [{ path: 'other.py', content: 'x' }],
      [
        { path: 'solution.py', content: 'a' },
        { path: 'solution.py', content: 'b' },
      ],
    ]) {
      expect(buildRunnerJob(question, { files }, 'public', jobId, runtime).ok).toBe(false);
    }
  });

  test('limits are clamped into the bounds and defaults fill the rest', () => {
    const built = buildRunnerJob(question, snapshot, 'public', jobId, runtime);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.limits).toEqual({
      wallSeconds: RUNNER_BOUNDS.wallSeconds.max,
      memoryMiB: RUNNER_BOUNDS.memoryMiB.max,
      outputBytes: RUNNER_BOUNDS.outputBytes.default,
    });
  });

  test('a replay pins the image it is given', () => {
    const image = `sha256:${'d'.repeat(64)}`;
    const built = buildRunnerJob(question, snapshot, 'full', jobId, runtime, image);
    expect(built.ok && built.job.runtime).toEqual({ id: 'python-3.12', language: 'python', image });
  });

  test('code larger than the job allows is refused', () => {
    const big = { files: [{ path: 'solution.py', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] };
    expect(buildRunnerJob(question, big, 'public', jobId, runtime)).toEqual({
      ok: false,
      message: 'The code is too large to run',
    });
  });
});

describe('hashes (design §8.2)', () => {
  test('A12 the code hash names the files only and is stable under order and key order', () => {
    const a = {
      files: [
        { path: 'b.py', content: '2' },
        { path: 'a.py', content: '1' },
      ],
    };
    const b = {
      files: [
        { content: '1', path: 'a.py' },
        { content: '2', path: 'b.py' },
      ],
    };
    expect(codeHash(a)).toBe(codeHash(b));
    expect(codeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash({ files: [{ path: 'a.py', content: '1 ' }] })).not.toBe(
      codeHash({ files: [{ path: 'a.py', content: '1' }] }),
    );
  });

  test('the grader version follows checks, non-editable files, limits and image, not the prompt', () => {
    const base = graderVersion(question, runtime);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(graderVersion({ ...question, prompt: 'Reworded.' }, runtime)).toBe(base);
    expect(
      graderVersion({ ...question, files: question.files.map((f) => ({ ...f })) }, runtime),
    ).toBe(base);
    expect(graderVersion({ ...question, limits: { wallSeconds: 5 } }, runtime)).not.toBe(base);
    expect(graderVersion(question, { ...runtime, digest: `sha256:${'a'.repeat(64)}` })).not.toBe(
      base,
    );
    expect(graderVersion({ ...question, checks: question.checks.slice(0, 1) }, runtime)).not.toBe(
      base,
    );
  });
});
