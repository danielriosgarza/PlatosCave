import type { RunnerJob, RunnerOutcome } from '@parallax/contracts';
import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Keys that may hold student code, check definitions, captured output, expectations or the
 * nonce. Removed from every log line wherever they appear (top level or one level down), so a
 * job or an outcome passed to the logger by mistake loses its contents (design §7.6).
 */
const SECRET_KEYS = [
  'job',
  'data',
  'outcome',
  'output',
  'result',
  'payload',
  'stdin',
  'files',
  'checks',
  'content',
  'expected',
  'actual',
  'stdout',
  'stderr',
  'harnessLog',
  'nonce',
  'compileError',
];

export const REDACT_PATHS = [...SECRET_KEYS, ...SECRET_KEYS.map((key) => `*.${key}`)];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    name: 'runner',
    redact: { paths: REDACT_PATHS, remove: true },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** The fields a log line may carry about a job (design §7.6). */
export function jobFields(job: Pick<RunnerJob, 'jobId' | 'runtime'>) {
  return { jobId: job.jobId, runtimeId: job.runtime.id };
}

/** The fields a log line may carry about an outcome (design §7.6). */
export function outcomeFields(outcome: RunnerOutcome) {
  return {
    jobId: outcome.jobId,
    imageId: outcome.image.id,
    status: outcome.status,
    durationMs: outcome.container.durationMs,
  };
}
