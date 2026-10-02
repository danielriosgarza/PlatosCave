import { RUNNER_MAX_JOB_BYTES, RunnerJob, validateJob } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { buildStdin, NONCE_LINE_BYTES, newNonce, STDIN_CAP_BYTES } from './payload';

const base: RunnerJob = {
  v: 1,
  jobId: '6f1d2c3a-4b5e-4f60-9a71-82b3c4d5e6f7',
  runtime: { id: 'python-3.12', language: 'python' },
  set: 'public',
  limits: { wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 },
  files: [{ path: 'solution.py', content: 'print(input())\n' }],
  checks: [],
};

/** A valid job whose JSON is exactly `bytes` long, padded through check stdin. */
function jobOfSize(bytes: number): RunnerJob {
  const check = (i: number, stdin: string) => ({
    name: `c${i}`,
    kind: 'stdio' as const,
    visibility: 'public' as const,
    file: 'solution.py',
    stdin,
    expected: { stdout: '' },
    compare: { mode: 'exact' as const },
  });
  const job: RunnerJob = { ...base, checks: Array.from({ length: 17 }, (_, i) => check(i, '')) };
  const empty = Buffer.byteLength(JSON.stringify(job));
  let left = bytes - empty;
  job.checks = job.checks.map((_, i) => {
    const take = Math.min(left, 256 * 1024);
    left -= take;
    return check(i, 'y'.repeat(take));
  });
  if (left !== 0) throw new Error('not enough checks to pad');
  return job;
}

describe('sandbox stdin (design §4.2)', () => {
  test('nonce is 32 lowercase hex characters from 16 random bytes', () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });

  test('stream is the nonce, a newline and the job JSON', () => {
    const nonce = newNonce();
    const job = jobOfSize(4096);
    const stream = buildStdin(nonce, job);
    expect(stream.subarray(0, NONCE_LINE_BYTES).toString('ascii')).toBe(`${nonce}\n`);
    expect(JSON.parse(stream.subarray(NONCE_LINE_BYTES).toString('utf8'))).toEqual(job);
  });

  test('a maximal 4 MiB job is written whole after the nonce line', () => {
    const job = jobOfSize(RUNNER_MAX_JOB_BYTES);
    expect(RunnerJob.safeParse(job).success).toBe(true);
    expect(validateJob(job)).toEqual({ ok: true });
    const stream = buildStdin(newNonce(), job);
    expect(stream.length).toBe(RUNNER_MAX_JOB_BYTES + 33);
    expect(stream.length).toBe(STDIN_CAP_BYTES);
    expect(stream.subarray(NONCE_LINE_BYTES).toString('utf8')).toBe(JSON.stringify(job));
  });

  test('a job one byte over 4 MiB is refused', () => {
    expect(() => buildStdin(newNonce(), jobOfSize(RUNNER_MAX_JOB_BYTES + 1))).toThrow(/above/);
  });

  test('a malformed nonce is refused', () => {
    expect(() => buildStdin('ABC', base)).toThrow(/nonce/);
  });
});
