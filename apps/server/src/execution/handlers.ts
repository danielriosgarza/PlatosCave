import type { PgBoss } from 'pg-boss';
import type { Db } from '../db/client';
import { onDeadLetter, onResultMessage, UnknownRunError } from '../db/execution/results';
import type { JobLogger } from '../jobs/logger';
import { FAILED_QUEUE, RESULT_QUEUE, RUN_QUEUE } from './queues';

/**
 * The worker's consumers of the runner's channel (docs/design/runner.md §8.5). They are plain
 * pg-boss workers, not scoped jobs: their messages come from the runner and name no actor. They
 * only settle the run a message names, and never change an attempt's grade (§1).
 */
export async function workExecution(boss: PgBoss, db: Db, log: JobLogger): Promise<string[]> {
  await boss.work(RESULT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const done = await onResultMessage(db, boss, RUN_QUEUE, job.data, new Date());
        if (done === 'invalid')
          log.warn({ messageId: job.id }, 'execution result fails RunnerOutcome');
      } catch (err) {
        // Thrown, so pg-boss retries: the row's transaction may not have committed yet.
        if (err instanceof UnknownRunError) log.warn({ messageId: job.id }, err.message);
        else log.error({ err, messageId: job.id }, 'execution result failed');
        throw err;
      }
    }
  });
  await boss.work(FAILED_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      try {
        const done = await onDeadLetter(db, job, new Date());
        if (done === 'mismatch' || done === 'invalid') {
          log.warn({ deadLetterId: job.id, sourceId: job.sourceId, done }, 'dead letter ignored');
        }
      } catch (err) {
        log.error({ err, deadLetterId: job.id }, 'execution dead letter failed');
        throw err;
      }
    }
  });
  return [RESULT_QUEUE, FAILED_QUEUE];
}
