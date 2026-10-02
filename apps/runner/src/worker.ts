import {
  clampLimits,
  RunnerJob,
  RunnerOutcome,
  type RunnerOutcome as RunnerOutcomeType,
  validateJob,
} from '@parallax/contracts';
import type { Job, JobResult, PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { classify } from './classify';
import type { Executor } from './executor';
import { RunnerFailure } from './failure';
import { extractFrame, stdoutCap } from './frame';
import { jobFields, outcomeFields } from './log';
import type { ResolvedImage } from './policy';

/** Schema of the runner's pg-boss instance (design §1, §7.2). */
export const EXEC_SCHEMA = 'pgboss_exec';
export const RUN_QUEUE = 'execution.run';
export const RESULT_QUEUE = 'execution.result';
export const FAILED_QUEUE = 'execution.failed';

export interface ImageResolver {
  resolve(runtime: RunnerJob['runtime']): Promise<ResolvedImage>;
}

export interface WorkerDeps {
  boss: Pick<PgBoss, 'send' | 'work'>;
  executor: Executor;
  images: ImageResolver;
  log: Logger;
}

/** A payload that is not a `RunnerJob` obeying §3.1 is terminal `job_invalid`. */
export function parseJob(data: unknown): RunnerJob {
  const parsed = RunnerJob.safeParse(data);
  if (!parsed.success) {
    // Paths and zod's messages only: never the offending values (design §7.6).
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RunnerFailure('job_invalid', `job fails RunnerJob: ${where.join('; ')}`);
  }
  const verdict = validateJob(parsed.data);
  if (!verdict.ok) {
    throw new RunnerFailure('job_invalid', `job breaks rule ${verdict.rule}: ${verdict.message}`);
  }
  // Clamp once more; the schema already holds every limit inside RUNNER_BOUNDS.
  return { ...parsed.data, limits: clampLimits(parsed.data.limits) };
}

/** Runs one job to an outcome; infrastructure problems are thrown as `RunnerFailure`. */
export async function runJob(
  job: RunnerJob,
  deps: Pick<WorkerDeps, 'executor' | 'images'>,
): Promise<RunnerOutcomeType> {
  const image = await deps.images.resolve(job.runtime);
  const run = await deps.executor.run(job, image);
  const frame = run.stdoutOverflow
    ? ({ kind: 'oversize' } as const)
    : extractFrame(run.stdout, run.nonce, stdoutCap(job.limits.outputBytes));
  const verdict = classify(run, frame, job);
  if (verdict.kind === 'failure') throw new RunnerFailure(verdict.failure, verdict.message);
  return RunnerOutcome.parse({
    v: 1,
    jobId: job.jobId,
    status: verdict.status,
    image,
    container: {
      exitCode: run.exitCode,
      oomKilled: run.oomKilled,
      killedByTimer: run.killedByTimer,
      durationMs: run.durationMs,
    },
    result: verdict.result,
    harnessLog: run.stderrTail,
  });
}

/**
 * One `execution.run` job (design §7.5). An outcome is sent as the `execution.result` message
 * with `id: jobId` (a `null` send is the duplicate pg-boss dropped, not an error) and then
 * returned as the job's output. A transient failure is thrown so pg-boss retries the job; a
 * terminal one is dead-lettered to `execution.failed` with `{ kind, message }` as its output.
 */
export async function handleJob(job: Job<unknown>, deps: WorkerDeps): Promise<JobResult> {
  const started = Date.now();
  const context = { bossJobId: job.id, retryCount: job.retryCount };
  try {
    const parsed = parseJob(job.data);
    const outcome = await runJob(parsed, deps);
    const sent = await deps.boss.send(RESULT_QUEUE, outcome, {
      id: outcome.jobId,
      singletonKey: outcome.jobId,
    });
    deps.log.info(
      { ...context, ...jobFields(parsed), ...outcomeFields(outcome), duplicate: sent === null },
      'run finished',
    );
    return { id: job.id, status: 'completed', output: outcome };
  } catch (error) {
    const failure =
      error instanceof RunnerFailure
        ? error
        : new RunnerFailure('harness_failed', `runner error: ${String(error)}`);
    deps.log.warn(
      {
        ...context,
        jobId: loggableJobId(job.data),
        kind: failure.kind,
        terminal: failure.terminal,
        durationMs: Date.now() - started,
      },
      `run failed: ${failure.message}`,
    );
    if (failure.terminal) return { id: job.id, status: 'deadletter', output: failure.toOutput() };
    throw failure;
  }
}

function loggableJobId(data: unknown): string | undefined {
  const id = (data as { jobId?: unknown } | null)?.jobId;
  return typeof id === 'string' && id.length <= 36 ? id : undefined;
}

/** One `work()` registration per slot, each fetching one job at a time (design §7.1). */
export async function startSlots(deps: WorkerDeps, slots: number): Promise<string[]> {
  const ids: string[] = [];
  for (let slot = 0; slot < slots; slot++) {
    ids.push(
      await deps.boss.work(
        RUN_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 1, perJobResults: true },
        async (jobs) => Promise.all(jobs.map((job) => handleJob(job, deps))),
      ),
    );
  }
  return ids;
}
