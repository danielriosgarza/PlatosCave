import type { PgBoss } from 'pg-boss';

/**
 * The queues of the runner's channel, schema `pgboss_exec` (docs/design/runner.md §8.4). Only
 * `apps/server` creates them, because creating a queue is DDL the runner's role may not run.
 * They are plain pg-boss queues, never scoped jobs: the payload is a `RunnerJob` without any
 * actor, and authorisation is complete before a run is sent and repeated on every read.
 */
export const RUN_QUEUE = 'execution.run';
export const RESULT_QUEUE = 'execution.result';
export const FAILED_QUEUE = 'execution.failed';

/** Completed and dead-lettered jobs keep student code; `execution_results` is the record. */
const KEEP_SECONDS = 3600;

/** Priorities (§5): an interactive student never waits behind grading or a bulk regrade. */
export const PRIORITY = { sample: 10, preview: 10, grading: 5, replay: 0, regrade: 0 } as const;

const queues = [
  { name: FAILED_QUEUE, policy: 'standard', options: { deleteAfterSeconds: KEEP_SECONDS } },
  {
    name: RESULT_QUEUE,
    policy: 'short',
    options: { retryLimit: 5, retryDelay: 2, retryBackoff: true, deleteAfterSeconds: KEEP_SECONDS },
  },
  {
    name: RUN_QUEUE,
    policy: 'standard',
    options: {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 120,
      deleteAfterSeconds: KEEP_SECONDS,
      deadLetter: FAILED_QUEUE,
    },
  },
] as const;

/**
 * Creates the three queues, or brings existing ones in line (idempotent; API and worker both
 * call it at start-up). The dead-letter queue is created first so `execution.run` can name it.
 */
export async function ensureExecQueues(boss: PgBoss): Promise<void> {
  for (const { name, policy, options } of queues) {
    await boss.createQueue(name, { policy, ...options });
    await boss.updateQueue(name, options);
  }
}
