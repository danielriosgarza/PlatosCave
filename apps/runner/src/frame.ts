import { RUNNER_MAX_CHECKS } from '@parallax/contracts';

const KiB = 1024;

/** Bound on one check entry besides its captured streams (design §7.4). */
export const CHECK_ENTRY_BYTES = 5 * KiB;
/** `compileError`, `runtime`, top-level fields and the marker lines (design §7.4). */
export const FRAME_OVERHEAD_BYTES = 64 * KiB;

/**
 * Most bytes of container stdout the runner reads: `outputBytes + 50 × 5 KiB + 64 KiB`. A
 * legitimate frame always fits, even at the minimum `outputBytes` with 50 maximal checks;
 * only the harness writes to this stream (design §4.4), so the cap bounds the harness.
 */
export function stdoutCap(outputBytes: number): number {
  return outputBytes + RUNNER_MAX_CHECKS * CHECK_ENTRY_BYTES + FRAME_OVERHEAD_BYTES;
}

export type FrameVerdict =
  | { kind: 'frame'; body: string; noiseBytes: number }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'oversize' };

/**
 * Finds the one nonce-framed result in the container's stdout:
 *
 *     \n--parallax-result <nonce>\n<one-line JSON>\n--parallax-end <nonce>\n
 *
 * Bytes before, between and after the frame are noise and never a reason to reject (design
 * §4.4). A marker with another nonce is noise too: student code does not know the nonce. Two
 * start or end markers with the job's nonce, or markers out of place, are malformed; a stream
 * longer than `cap` is oversize.
 */
export function extractFrame(stdout: Buffer, nonce: string, cap: number): FrameVerdict {
  if (stdout.length > cap) return { kind: 'oversize' };
  const start = `--parallax-result ${nonce}`;
  const end = `--parallax-end ${nonce}`;
  const lines = stdout.toString('utf8').split('\n');
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line === start) starts.push(i);
    else if (line === end) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) return { kind: 'missing' };
  if (starts.length !== 1 || ends.length !== 1) {
    return { kind: 'malformed', reason: 'expected exactly one start and one end marker' };
  }
  const [at] = starts as [number];
  if (ends[0] !== at + 2) return { kind: 'malformed', reason: 'markers do not enclose one line' };
  const body = lines[at + 1] ?? '';
  // The leading newline and the three line ends belong to the frame.
  const frameBytes =
    Buffer.byteLength(start) + Buffer.byteLength(body) + Buffer.byteLength(end) + 4;
  return { kind: 'frame', body, noiseBytes: Math.max(0, stdout.length - frameBytes) };
}
