import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  clampLimits,
  RUNNER_BOUNDS,
  RunnerJob,
  RunnerOutcome,
  RunnerResult,
  validateJob,
} from './runner';

const EXAMPLES = new URL('../../../runner/protocol/v1/examples/', import.meta.url);

const read = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${dir}${name}`, EXAMPLES), 'utf8'));
const list = (dir: string): string[] =>
  readdirSync(new URL(dir || '.', EXAMPLES)).filter((f) => f.endsWith('.json'));
const schemaFor = (name: string) => (name.startsWith('job-') ? RunnerJob : RunnerResult);

const sample = () => RunnerJob.parse(read('', 'job-sample-python.json'));

describe('runner protocol v1 examples', () => {
  test.each(list(''))('parses %s', (name) => {
    const parsed = schemaFor(name).safeParse(read('', name));
    expect(parsed.error).toBeUndefined();
    if (name.startsWith('job-'))
      expect(validateJob(RunnerJob.parse(read('', name)))).toEqual({ ok: true });
  });

  /** The schema rule each invalid fixture breaks, named by the key the zod issue points at. */
  const invalidKey: Record<string, string> = {
    'job-call-value-and-raises.json': 'expected',
    'job-image-tag-not-pinned.json': 'image',
    'job-limits-over-bounds.json': 'wallSeconds',
    'job-path-traversal.json': 'path',
    'result-extra-property.json': 'hiddenValue',
    'result-unknown-status.json': 'status',
  };

  test('every invalid fixture has a named rule', () => {
    expect(list('invalid/').sort()).toEqual(Object.keys(invalidKey).sort());
  });

  test.each(Object.entries(invalidKey))('rejects invalid/%s on %s', (name, key) => {
    const parsed = schemaFor(name).safeParse(read('invalid/', name));
    expect(parsed.success).toBe(false);
    const issues = parsed.error?.issues ?? [];
    const keys = issues.flatMap((i) => [
      ...i.path.map(String),
      ...('keys' in i ? (i.keys as string[]) : []),
    ]);
    expect(keys).toContain(key);
  });

  /** The semantic rule of design §3.1 each rejected fixture breaks. */
  const rejectedRule: Record<string, number> = {
    'job-duplicate-check-names.json': 1,
    'job-public-set-with-hidden-check.json': 2,
    'job-public-set-with-hidden-file.json': 2,
    'job-check-names-missing-file.json': 3,
    'job-public-check-names-hidden-file.json': 3,
    'job-duplicate-paths.json': 4,
    'job-path-is-directory.json': 4,
  };

  test('every rejected fixture has a named rule', () => {
    expect(list('rejected/').sort()).toEqual(Object.keys(rejectedRule).sort());
  });

  test.each(Object.entries(rejectedRule))('rejects rejected/%s by rule %i', (name, rule) => {
    const job = RunnerJob.parse(read('rejected/', name));
    const verdict = validateJob(job);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.rule).toBe(rule);
  });
});

describe('validateJob size rules', () => {
  test('files over 2 MiB decoded are rejected by rule 4', () => {
    const job = sample();
    job.files.push({ path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) });
    expect(validateJob(job)).toMatchObject({ ok: false, rule: 4 });
  });

  test('base64 counts decoded bytes and must be valid', () => {
    const job = sample();
    job.files.push({ path: 'blob.bin', content: 'AAEC', encoding: 'base64' });
    expect(validateJob(job)).toEqual({ ok: true });
    job.files.push({ path: 'bad.bin', content: 'AAE', encoding: 'base64' });
    expect(validateJob(job)).toMatchObject({ ok: false, rule: 4 });
  });

  test('a serialised job over 4 MiB is rejected by rule 4', () => {
    const job = sample();
    const first = job.checks[0];
    if (!first) throw new Error('fixture has a check');
    // 50 checks with 128 KiB of stdin each: 6.25 MiB of JSON with tiny files.
    job.checks = Array.from({ length: 50 }, (_, i) => ({
      ...first,
      name: `c${i}`,
      stdin: 'y'.repeat(128 * 1024),
    }));
    expect(RunnerJob.safeParse(job).success).toBe(true);
    expect(validateJob(job)).toMatchObject({ ok: false, rule: 4 });
  });
});

describe('RunnerJob schema', () => {
  test('code points, not UTF-16 units, are counted for maxLength', () => {
    const job = sample();
    const first = job.checks[0];
    if (!first) throw new Error('fixture has a check');
    first.stdin = '😀'.repeat(256 * 1024); // 256 Ki code points, 512 Ki UTF-16 units
    expect(RunnerJob.safeParse(job).success).toBe(true);
    first.stdin = `${first.stdin}x`;
    expect(RunnerJob.safeParse(job).success).toBe(false);
  });

  test('a job id that is not a uuid is refused', () => {
    expect(RunnerJob.safeParse({ ...sample(), jobId: 'job-1' }).success).toBe(false);
  });
});

describe('clampLimits', () => {
  test('fills defaults', () => {
    expect(clampLimits()).toEqual({ wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 });
  });

  test('pulls every limit into its bounds', () => {
    for (const [name, bound] of Object.entries(RUNNER_BOUNDS)) {
      expect(clampLimits({ [name]: bound.min - 1 })[name as keyof typeof RUNNER_BOUNDS]).toBe(
        bound.min,
      );
      expect(clampLimits({ [name]: bound.max + 1 })[name as keyof typeof RUNNER_BOUNDS]).toBe(
        bound.max,
      );
      expect(clampLimits({ [name]: bound.min })[name as keyof typeof RUNNER_BOUNDS]).toBe(
        bound.min,
      );
      expect(clampLimits({ [name]: bound.max })[name as keyof typeof RUNNER_BOUNDS]).toBe(
        bound.max,
      );
    }
  });
});

describe('RunnerOutcome', () => {
  const result = RunnerResult.parse(read('', 'result-passed.json'));
  const outcome = {
    v: 1,
    jobId: '6f1d2c3a-4b5e-4f60-9a71-82b3c4d5e6f7',
    status: 'passed',
    image: { ref: 'parallax-runner-python:dev', id: `sha256:${'a'.repeat(64)}`, digest: null },
    container: { exitCode: 0, oomKilled: false, killedByTimer: false, durationMs: 120 },
    result,
    harnessLog: '',
  };

  test('accepts an outcome with a result', () => {
    expect(RunnerOutcome.safeParse(outcome).success).toBe(true);
  });

  test('a null result needs a memory kill or the kill timer', () => {
    expect(RunnerOutcome.safeParse({ ...outcome, result: null }).success).toBe(false);
    expect(
      RunnerOutcome.safeParse({
        ...outcome,
        status: 'time_limited',
        result: null,
        container: { ...outcome.container, exitCode: null, killedByTimer: true },
      }).success,
    ).toBe(true);
  });

  test('harnessLog is bounded at 8 KiB', () => {
    expect(RunnerOutcome.safeParse({ ...outcome, harnessLog: 'é'.repeat(4097) }).success).toBe(
      false,
    );
  });
});
