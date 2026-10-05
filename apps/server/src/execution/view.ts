import { RunnerOutcome } from '@parallax/contracts';
import type { ExecutionState, InstructorRun, StudentRun } from '@parallax/contracts/routes/runs';

/**
 * What a run looks like to its student and to instructors (docs/design/runner.md §8.6). Pure:
 * the data-access layer hands in the stored row, its result and the state read from the queue.
 */

/** The fields of an `execution_jobs` row the views read. */
export interface RunRecord {
  id: string;
  state: ExecutionState;
  checkSet: 'public' | 'full';
  reason: 'sample' | 'grading' | 'replay' | 'regrade' | 'preview';
  questionId: string;
  questionRevisionId: string;
  codeHash: string;
  graderVersion: string;
  runtimeId: string;
  imageRef: string;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  infrastructureAttempts: number | null;
  failure: { kind: string; message: string } | null;
  requestedBy: string | null;
  note: string | null;
  supersededBy: string | null;
}

/** The fields of an `execution_results` row the views read. */
export interface ResultRecord {
  status: 'passed' | 'failed' | 'time_limited' | 'resource_exhausted';
  imageId: string;
  imageDigest: string | null;
  harnessVersion: string;
  outcome: Record<string, unknown>;
}

/** A non-terminal row's state as the queue reports it (§8.5); absent for a terminal row. */
export interface LiveState {
  state: 'queued' | 'running';
  queuePosition?: number;
  startedAt?: Date | null;
}

const iso = (d: Date | null | undefined) => d?.toISOString();

/**
 * The student view of a `public` run. Anything else is a programming error: a `full` outcome ran
 * beside hidden checks and reaches students only through released grades.
 */
export function toStudentView(
  run: RunRecord,
  result: ResultRecord | null,
  live?: LiveState,
): StudentRun {
  if (run.checkSet !== 'public' || run.reason !== 'sample') {
    throw new Error(`run ${run.id} is not a sample run and has no student view`);
  }
  const state = live?.state ?? run.state;
  const startedAt = live?.startedAt ?? run.startedAt;
  const view: StudentRun = {
    runId: run.id,
    state,
    codeHash: run.codeHash,
    queuedAt: run.queuedAt.toISOString(),
    ...(live?.queuePosition !== undefined && { queuePosition: live.queuePosition }),
    ...(startedAt && { startedAt: startedAt.toISOString() }),
    ...(run.finishedAt && { finishedAt: run.finishedAt.toISOString() }),
  };
  if (!result) return view;
  const outcome = RunnerOutcome.parse(result.outcome);
  const harness = outcome.result;
  return {
    ...view,
    result: {
      status: outcome.status,
      ...(harness && { runtime: harness.runtime }),
      ...(harness?.compileError && { compileError: harness.compileError }),
      checks: (harness?.checks ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        ...(c.errorKind !== undefined && { errorKind: c.errorKind }),
        durationMs: c.durationMs,
        ...(c.expected !== undefined && { expected: c.expected }),
        ...(c.actual !== undefined && { actual: c.actual }),
        ...(c.message !== undefined && { message: c.message }),
        ...(c.exitCode !== undefined && { exitCode: c.exitCode }),
        ...(c.signal !== undefined && { signal: c.signal }),
        stdout: c.stdout,
        stderr: c.stderr,
        truncated: c.truncated,
      })),
      truncated: harness?.truncated ?? false,
      durationMs: harness?.durationMs ?? outcome.container.durationMs,
    },
  };
}

/** The instructor view of any run: the stored outcome as recorded, hidden checks included. */
export function toInstructorView(
  run: RunRecord,
  result: ResultRecord | null,
  live?: LiveState,
): InstructorRun {
  return {
    runId: run.id,
    state: live?.state ?? run.state,
    questionId: run.questionId,
    questionRevisionId: run.questionRevisionId,
    reason: run.reason,
    checkSet: run.checkSet,
    codeHash: run.codeHash,
    graderVersion: run.graderVersion,
    runtimeId: run.runtimeId,
    imageRef: run.imageRef,
    ...(live?.queuePosition !== undefined && { queuePosition: live.queuePosition }),
    queuedAt: run.queuedAt.toISOString(),
    startedAt: iso(live?.startedAt ?? run.startedAt) ?? null,
    finishedAt: iso(run.finishedAt) ?? null,
    infrastructureAttempts: run.infrastructureAttempts,
    failure: run.failure,
    requestedBy: run.requestedBy,
    note: run.note,
    supersededBy: run.supersededBy,
    result: result && {
      status: result.status,
      imageId: result.imageId,
      imageDigest: result.imageDigest,
      harnessVersion: result.harnessVersion,
      outcome: result.outcome,
    },
  };
}
