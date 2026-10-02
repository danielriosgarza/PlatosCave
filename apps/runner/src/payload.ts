import { randomBytes } from 'node:crypto';
import { RUNNER_MAX_JOB_BYTES, type RunnerJob } from '@parallax/contracts';

/** 32 hex characters and a newline: the first line of the sandbox's stdin. */
export const NONCE_LINE_BYTES = 33;

/** The harness reads at most this many bytes from stdin (design §4.2). */
export const STDIN_CAP_BYTES = RUNNER_MAX_JOB_BYTES + NONCE_LINE_BYTES;

/** A fresh nonce per container: `crypto.randomBytes(16)` as 32 lowercase hex characters. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The bytes written to the sandbox's stdin: the nonce line, then the validated job's JSON of at
 * most 4 MiB. Nothing else reaches the container (design §4.2, §7.3).
 */
export function buildStdin(nonce: string, job: RunnerJob): Buffer {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('nonce must be 32 lowercase hex characters');
  const body = Buffer.from(JSON.stringify(job), 'utf8');
  if (body.length > RUNNER_MAX_JOB_BYTES) {
    throw new Error(`job JSON is ${body.length} bytes, above ${RUNNER_MAX_JOB_BYTES}`);
  }
  return Buffer.concat([Buffer.from(`${nonce}\n`, 'ascii'), body]);
}
