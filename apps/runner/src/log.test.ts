import { Writable } from 'node:stream';
import { RunnerJob, RunnerOutcome } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { createLogger, jobFields, outcomeFields } from './log';

const job = RunnerJob.parse({
  v: 1,
  jobId: '6f1d2c3a-4b5e-4f60-9a71-82b3c4d5e6f7',
  runtime: { id: 'python-3.12', language: 'python' },
  set: 'full',
  limits: { wallSeconds: 10, memoryMiB: 512, outputBytes: 1048576 },
  files: [
    { path: 'solution.py', content: 'SECRET_SOLUTION_SOURCE = 1\n' },
    { path: 'tests/hidden.py', content: 'SECRET_HIDDEN_TEST\n', hidden: true },
  ],
  checks: [
    {
      name: 'Hidden mean',
      kind: 'call',
      visibility: 'hidden',
      file: 'solution.py',
      function: 'mean',
      args: ['SECRET_ARGUMENT'],
      stdin: 'SECRET_STDIN',
      expected: { value: 'SECRET_EXPECTED_VALUE' },
      compare: { mode: 'exact' },
    },
  ],
});

const outcome = RunnerOutcome.parse({
  v: 1,
  jobId: job.jobId,
  status: 'failed',
  image: { ref: 'parallax-runner-python:dev', id: `sha256:${'a'.repeat(64)}`, digest: null },
  container: { exitCode: 0, oomKilled: false, killedByTimer: false, durationMs: 321 },
  result: {
    v: 1,
    harnessVersion: '1',
    runtime: { language: 'python', version: '3.12.8' },
    checks: [
      {
        name: 'Hidden mean',
        status: 'failed',
        durationMs: 3,
        expected: 'SECRET_EXPECTED_SHOWN',
        actual: 'SECRET_ACTUAL',
        message: 'SECRET_MESSAGE',
        stdout: 'SECRET_STDOUT',
        stderr: 'SECRET_STDERR',
        truncated: false,
      },
    ],
    truncated: false,
    durationMs: 9,
  },
  harnessLog: 'SECRET_HARNESS_LOG',
});

const nonce = '0123456789abcdef0123456789abcdef';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { log: createLogger('trace', stream), lines };
}

describe('runner logs (design §7.6)', () => {
  test('a job and an outcome passed to the logger lose their contents', () => {
    const { log, lines } = capture();
    log.info({ job, outcome, nonce, data: job, output: outcome, ...jobFields(job) }, 'run');
    log.info({ wrapped: { job, result: outcome.result, stdout: 'SECRET_STDOUT', nonce } }, 'x');
    log.info({ ...outcomeFields(outcome), retryCount: 2 }, 'run finished');
    const text = lines.join('');
    for (const secret of [
      'SECRET_SOLUTION_SOURCE',
      'SECRET_HIDDEN_TEST',
      'SECRET_ARGUMENT',
      'SECRET_STDIN',
      'SECRET_EXPECTED_VALUE',
      'SECRET_EXPECTED_SHOWN',
      'SECRET_ACTUAL',
      'SECRET_MESSAGE',
      'SECRET_STDOUT',
      'SECRET_STDERR',
      'SECRET_HARNESS_LOG',
      'Hidden mean',
      nonce,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test('the allowed fields are logged', () => {
    const { log, lines } = capture();
    log.info({ ...jobFields(job), ...outcomeFields(outcome), retryCount: 2 }, 'run finished');
    const line = JSON.parse(lines[0] ?? '{}');
    expect(line).toMatchObject({
      jobId: job.jobId,
      runtimeId: 'python-3.12',
      imageId: outcome.image.id,
      status: 'failed',
      durationMs: 321,
      retryCount: 2,
    });
  });

  test('errors keep their message', () => {
    const { log, lines } = capture();
    log.error({ err: new Error('docker: connect ENOENT') }, 'failed');
    expect(lines.join('')).toContain('connect ENOENT');
  });
});
