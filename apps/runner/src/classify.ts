import {
  type RunnerFailureKind,
  type RunnerJob,
  type RunnerOutcomeStatus,
  RunnerResult,
} from '@parallax/contracts';
import type { FrameVerdict } from './frame';

/** What the runner observed about one finished container. */
export interface ContainerState {
  exitCode: number | null;
  oomKilled: boolean;
  killedByTimer: boolean;
}

export type Classification =
  | { kind: 'outcome'; status: RunnerOutcomeStatus; result: RunnerResult | null }
  | { kind: 'failure'; failure: RunnerFailureKind; message: string };

/** Job status implied by a valid result (design §7.4, rows below the frame rows). */
export function statusFromResult(result: RunnerResult): RunnerOutcomeStatus {
  const checks = result.checks;
  if (checks.some((c) => c.status === 'error' && c.errorKind === 'memory')) {
    return 'resource_exhausted';
  }
  if (checks.some((c) => c.status === 'timeout')) return 'time_limited';
  if (result.compileError || checks.some((c) => c.status !== 'passed')) return 'failed';
  return 'passed';
}

type ParsedFrame = { ok: true; result: RunnerResult } | { ok: false; message: string };

function parseFrame(frame: FrameVerdict, job: Pick<RunnerJob, 'checks'>): ParsedFrame | null {
  if (frame.kind === 'missing') return null;
  if (frame.kind === 'oversize') return { ok: false, message: 'stdout exceeded the read cap' };
  if (frame.kind === 'malformed') return { ok: false, message: frame.reason };
  let json: unknown;
  try {
    json = JSON.parse(frame.body);
  } catch {
    return { ok: false, message: 'frame body is not JSON' };
  }
  const parsed = RunnerResult.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
    return { ok: false, message: `result fails RunnerResult at ${where.join(', ')}` };
  }
  // One entry per job check, in job order: results are matched to checks by name.
  const names = parsed.data.checks.map((c) => c.name);
  if (names.length !== job.checks.length || job.checks.some((c, i) => c.name !== names[i])) {
    return { ok: false, message: 'result checks do not match the job checks' };
  }
  return { ok: true, result: parsed.data };
}

/**
 * Turns a finished container into an outcome or an infrastructure failure (design §7.4). Pure;
 * precedence is the table's, top to bottom:
 *
 * | exit 0 with one valid frame          | status from the result (OOMKilled is informational) |
 * | no valid frame and OOMKilled         | resource_exhausted                                  |
 * | no valid frame and the kill timer    | time_limited                                        |
 * | exit 64                              | job_invalid (terminal)                              |
 * | other non-zero exit                  | harness_failed                                      |
 * | no frame                             | result_missing                                      |
 * | frame failing RunnerResult, oversize | result_invalid                                      |
 */
export function classify(
  container: ContainerState,
  frame: FrameVerdict,
  job: Pick<RunnerJob, 'checks'>,
): Classification {
  const parsed = parseFrame(frame, job);
  if (container.exitCode === 0 && parsed?.ok) {
    return { kind: 'outcome', status: statusFromResult(parsed.result), result: parsed.result };
  }
  if (container.oomKilled) return { kind: 'outcome', status: 'resource_exhausted', result: null };
  if (container.killedByTimer) return { kind: 'outcome', status: 'time_limited', result: null };
  if (container.exitCode === 64) {
    return {
      kind: 'failure',
      failure: 'job_invalid',
      message: 'the harness refused the job (exit 64)',
    };
  }
  if (container.exitCode !== 0) {
    return {
      kind: 'failure',
      failure: 'harness_failed',
      message: `the harness exited with ${container.exitCode ?? 'no code'}`,
    };
  }
  if (parsed === null) {
    return { kind: 'failure', failure: 'result_missing', message: 'no result frame on stdout' };
  }
  return {
    kind: 'failure',
    failure: 'result_invalid',
    message: parsed.ok ? 'invalid result' : parsed.message,
  };
}
