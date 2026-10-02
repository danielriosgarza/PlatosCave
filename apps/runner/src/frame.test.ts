import { RUNNER_BOUNDS } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { extractFrame, stdoutCap } from './frame';
import { frameBytes, maximalResult } from './test-frames';

const nonce = '0123456789abcdef0123456789abcdef';
const other = 'fedcba9876543210fedcba9876543210';
const result = { v: 1, ok: true };
const cap = stdoutCap(RUNNER_BOUNDS.outputBytes.default);

describe('nonce-framed result (design §4.4)', () => {
  test('one frame is accepted', () => {
    const verdict = extractFrame(frameBytes(nonce, result), nonce, cap);
    expect(verdict).toEqual({ kind: 'frame', body: JSON.stringify(result), noiseBytes: 0 });
  });

  test('bytes before, between and after the frame are noise', () => {
    const stdout = Buffer.concat([
      Buffer.from('noise before without newline'),
      frameBytes(other, { forged: true }),
      Buffer.from('between\n'),
      frameBytes(nonce, result),
      Buffer.from('--parallax-result trailing noise\n\x00\xff'),
    ]);
    const verdict = extractFrame(stdout, nonce, cap);
    expect(verdict.kind).toBe('frame');
    expect(verdict.kind === 'frame' && JSON.parse(verdict.body)).toEqual(result);
    expect(verdict.kind === 'frame' && verdict.noiseBytes).toBeGreaterThan(0);
  });

  test('a frame with another nonce is not a result', () => {
    expect(extractFrame(frameBytes(other, result), nonce, cap)).toEqual({ kind: 'missing' });
  });

  test('two frames with the job nonce are rejected', () => {
    const stdout = Buffer.concat([frameBytes(nonce, result), frameBytes(nonce, result)]);
    expect(extractFrame(stdout, nonce, cap).kind).toBe('malformed');
  });

  test('markers that do not enclose one line are rejected', () => {
    const stdout = Buffer.from(`\n--parallax-result ${nonce}\n{}\n{}\n--parallax-end ${nonce}\n`);
    expect(extractFrame(stdout, nonce, cap).kind).toBe('malformed');
    const unterminated = Buffer.from(`\n--parallax-result ${nonce}\n{}\n`);
    expect(extractFrame(unterminated, nonce, cap).kind).toBe('malformed');
  });

  test('stdout beyond the cap is oversize', () => {
    const stdout = Buffer.concat([frameBytes(nonce, result), Buffer.alloc(cap)]);
    expect(extractFrame(stdout, nonce, cap)).toEqual({ kind: 'oversize' });
  });

  test('the cap is outputBytes + 50 × 5 KiB + 64 KiB', () => {
    expect(stdoutCap(4096)).toBe(4096 + 50 * 5 * 1024 + 64 * 1024);
  });

  test('a maximal frame at the minimum outputBytes with 50 checks fits the cap', () => {
    const outputBytes = RUNNER_BOUNDS.outputBytes.min;
    const stdout = frameBytes(nonce, maximalResult(outputBytes));
    expect(stdout.length).toBeLessThanOrEqual(stdoutCap(outputBytes));
    expect(extractFrame(stdout, nonce, stdoutCap(outputBytes)).kind).toBe('frame');
  });
});
