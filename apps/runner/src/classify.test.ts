import { RUNNER_BOUNDS, RunnerResult } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { type ContainerState, classify, statusFromResult } from './classify';
import { extractFrame, type FrameVerdict, stdoutCap } from './frame';
import { frameBytes, maximalJob, maximalResult } from './test-frames';

const nonce = '0123456789abcdef0123456789abcdef';
const job = { checks: [{ name: 'one' }, { name: 'two' }] } as never;
const check = (name: string, status: string, extra: object = {}) => ({
  name,
  status,
  durationMs: 1,
  stdout: '',
  stderr: '',
  truncated: false,
  ...extra,
});
const result = (checks: object[], extra: object = {}) =>
  RunnerResult.parse({
    v: 1,
    harnessVersion: '1',
    runtime: { language: 'python', version: '3.12.8' },
    checks,
    truncated: false,
    durationMs: 5,
    ...extra,
  });
const passed = result([check('one', 'passed'), check('two', 'passed')]);
const frameOf = (value: unknown): FrameVerdict =>
  extractFrame(frameBytes(nonce, value), nonce, stdoutCap(1048576));
const exited = (exitCode: number | null, extra: Partial<ContainerState> = {}): ContainerState => ({
  exitCode,
  oomKilled: false,
  killedByTimer: false,
  ...extra,
});

describe('classification (design §7.4)', () => {
  test('exit 0 with a valid frame takes its status from the result', () => {
    expect(classify(exited(0), frameOf(passed), job)).toEqual({
      kind: 'outcome',
      status: 'passed',
      result: passed,
    });
  });

  test('a valid frame wins over OOMKilled', () => {
    const memory = result([check('one', 'error', { errorKind: 'memory' }), check('two', 'passed')]);
    expect(classify(exited(0, { oomKilled: true }), frameOf(passed), job)).toMatchObject({
      kind: 'outcome',
      status: 'passed',
    });
    expect(classify(exited(0, { oomKilled: true }), frameOf(memory), job)).toMatchObject({
      kind: 'outcome',
      status: 'resource_exhausted',
    });
  });

  test('no valid frame and OOMKilled is resource_exhausted without a result', () => {
    expect(classify(exited(137, { oomKilled: true }), { kind: 'missing' }, job)).toEqual({
      kind: 'outcome',
      status: 'resource_exhausted',
      result: null,
    });
  });

  test('no valid frame and the kill timer is time_limited without a result', () => {
    expect(classify(exited(137, { killedByTimer: true }), { kind: 'missing' }, job)).toEqual({
      kind: 'outcome',
      status: 'time_limited',
      result: null,
    });
  });

  test('exit 64 is job_invalid', () => {
    expect(classify(exited(64), { kind: 'missing' }, job)).toMatchObject({
      kind: 'failure',
      failure: 'job_invalid',
    });
  });

  test('another non-zero exit is harness_failed, even with a frame', () => {
    expect(classify(exited(70), { kind: 'missing' }, job)).toMatchObject({
      failure: 'harness_failed',
    });
    expect(classify(exited(137), frameOf(passed), job)).toMatchObject({
      failure: 'harness_failed',
    });
  });

  test('exit 0 without a frame is result_missing', () => {
    expect(classify(exited(0), { kind: 'missing' }, job)).toMatchObject({
      failure: 'result_missing',
    });
  });

  test('a frame failing RunnerResult, a malformed frame or oversize stdout is result_invalid', () => {
    for (const frame of [
      frameOf({ ...passed, extra: true }),
      { kind: 'frame', body: '{not json', noiseBytes: 0 } as const,
      { kind: 'malformed', reason: 'two frames' } as const,
      { kind: 'oversize' } as const,
    ]) {
      expect(classify(exited(0), frame, job)).toMatchObject({ failure: 'result_invalid' });
    }
  });

  test('a result whose checks are not the job checks is result_invalid', () => {
    const swapped = result([check('two', 'passed'), check('one', 'passed')]);
    expect(classify(exited(0), frameOf(swapped), job)).toMatchObject({
      failure: 'result_invalid',
    });
  });

  test('result rows: memory, then timeout, then failure, then passed', () => {
    const memoryAndTimeout = result([
      check('one', 'timeout'),
      check('two', 'error', { errorKind: 'memory' }),
    ]);
    expect(statusFromResult(memoryAndTimeout)).toBe('resource_exhausted');
    expect(statusFromResult(result([check('one', 'timeout'), check('two', 'failed')]))).toBe(
      'time_limited',
    );
    for (const status of ['failed', 'skipped']) {
      expect(statusFromResult(result([check('one', 'passed'), check('two', status)]))).toBe(
        'failed',
      );
    }
    expect(
      statusFromResult(
        result([check('one', 'error', { errorKind: 'exception' }), check('two', 'passed')]),
      ),
    ).toBe('failed');
    expect(
      statusFromResult(
        result([check('one', 'skipped'), check('two', 'skipped')], {
          compileError: { file: 'solution.py', line: 1, message: 'invalid syntax' },
        }),
      ),
    ).toBe('failed');
    expect(statusFromResult(passed)).toBe('passed');
  });

  test('the maximal frame at the minimum outputBytes is classified from its result', () => {
    const outputBytes = RUNNER_BOUNDS.outputBytes.min;
    const maximal = maximalResult(outputBytes);
    const frame = extractFrame(frameBytes(nonce, maximal), nonce, stdoutCap(outputBytes));
    const verdict = classify(exited(0), frame, maximalJob());
    expect(verdict).toMatchObject({ kind: 'outcome', status: 'failed' });
    expect(verdict.kind === 'outcome' && verdict.result).toEqual(maximal);
  });
});
