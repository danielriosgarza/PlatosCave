import { RunnerOutcome } from '@parallax/contracts';
import { eq, sql } from 'drizzle-orm';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { LiveState } from '../../execution/view';
import type { Db, Tx } from '../client';
import { EXEC_SCHEMA } from '../jobs/boss';
import { executionJobs } from '../schema';
import { mapFailure, type RunRow, recordCancelled, recordFailure, recordOutcome } from './results';

/**
 * The staleness rule (docs/design/runner.md §8.5), keyed on the state of a row's pg-boss job. A
 * job `created`, `retry` or `active` is live however long it has waited; a row with no job yet
 * is live for the send window after it was queued, the only wall clock in the rule. A read of
 * the row under its own class scope settles a row that is not live from what its job (or its
 * result message) carries; the cap only counts and never settles.
 */

/** How long after `queued_at` a row may lack its job: the send follows the commit at once. */
export const SEND_WINDOW_MS = 60_000;

export type JobState = JobWithMetadata['state'];
const LIVE_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

/** Whether the cap counts a row whose job is in `jobState` (undefined: no job). */
export function isLive(
  row: Pick<RunRow, 'jobSentAt' | 'queuedAt'>,
  jobState: string | undefined,
  now: Date,
): boolean {
  if (jobState !== undefined) return LIVE_JOB_STATES.has(jobState);
  return row.jobSentAt === null && now.getTime() - row.queuedAt.getTime() < SEND_WINDOW_MS;
}

/**
 * The states of the run jobs of these rows in one statement (§2 step 3), the cap's lookup and one
 * of the two statements the server runs directly against `pgboss_exec`.
 */
export async function jobStates(
  ex: Db | Tx,
  runQueue: string,
  bossJobIds: string[],
): Promise<Map<string, string>> {
  if (bossJobIds.length === 0) return new Map();
  const result = await ex.execute<{ id: string; state: string }>(
    sql`SELECT id, state FROM ${sql.identifier(EXEC_SCHEMA)}.job WHERE name = ${runQueue} AND id = ANY(${sql.param(bossJobIds)}::uuid[])`,
  );
  return new Map(result.rows.map((r) => [r.id, r.state]));
}

/** Jobs fetched before this one (§5): higher priority whenever created, equal priority earlier. */
export async function queuePosition(
  ex: Db | Tx,
  runQueue: string,
  job: Pick<JobWithMetadata, 'priority' | 'createdOn'>,
): Promise<number> {
  const result = await ex.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM ${sql.identifier(EXEC_SCHEMA)}.job
        WHERE name = ${runQueue} AND state IN ('created', 'retry')
          AND (priority > ${job.priority} OR (priority = ${job.priority} AND created_on < ${job.createdOn}))`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export interface Queues {
  boss: PgBoss;
  run: string;
  result: string;
}

/** The outcome a result message or a completed job carries, or null when it is not one. */
const outcomeOf = (value: unknown) => {
  const parsed = RunnerOutcome.safeParse(value);
  return parsed.success ? parsed.data : null;
};

async function reload(db: Db, row: RunRow): Promise<RunRow> {
  const [fresh] = await db.select().from(executionJobs).where(eq(executionJobs.id, row.id));
  if (!fresh) throw new Error(`run ${row.id} vanished`);
  return fresh;
}

/**
 * Settles a run whose job is gone from its `execution.result` message, if there is one (the run
 * finished; its handler has not run yet). True when a message was found.
 */
async function settleFromMessage(db: Db, q: Queues, row: RunRow, now: Date): Promise<boolean> {
  const message = await q.boss.getJobById(q.result, row.id);
  if (!message) return false;
  const outcome = outcomeOf(message.data);
  if (outcome && outcome.jobId === row.id) await recordOutcome(db, row, outcome, null, now);
  else await recordFailure(db, row, { kind: 'result_invalid', message: 'result message' }, now);
  return true;
}

/**
 * A row as a read reports it: a terminal row as stored; an unsettled one with its live state
 * from the queue, or settled first when its job is not live (the §8.5 table). The caller has
 * loaded `row` under its own class scope.
 */
export async function readState(
  db: Db,
  q: Queues,
  row: RunRow,
  now: Date,
): Promise<{ row: RunRow; live?: LiveState }> {
  if (row.state !== 'queued' && row.state !== 'running') return { row };
  const job = await q.boss.getJobById(q.run, row.bossJobId);
  if (job) {
    switch (job.state) {
      case 'created':
      case 'retry':
        return {
          row,
          live: { state: 'queued', queuePosition: await queuePosition(db, q.run, job) },
        };
      case 'active':
        return { row, live: { state: 'running', startedAt: job.startedOn } };
      case 'completed': {
        const outcome = outcomeOf(job.output);
        if (outcome && outcome.jobId === row.id) await recordOutcome(db, row, outcome, job, now);
        else {
          await recordFailure(
            db,
            row,
            { kind: 'result_invalid', message: 'completed job without a valid outcome' },
            now,
          );
        }
        break;
      }
      case 'failed':
        await recordFailure(db, row, mapFailure(job.output), now);
        break;
      case 'cancelled':
        await recordCancelled(db, row, now);
        break;
    }
    return { row: await reload(db, row) };
  }
  if (await settleFromMessage(db, q, row, now)) return { row: await reload(db, row) };
  if (row.jobSentAt === null) {
    if (isLive(row, undefined, now)) return { row, live: { state: 'queued' } };
    const moved = await recordFailure(
      db,
      row,
      { kind: 'enqueue_failed', message: 'the run was never queued' },
      now,
      { unsent: true },
    );
    // A send that lands later finds its own conditional update refused and cancels; this
    // cancel covers the send that landed before the move (§2 step 4).
    if (moved) await q.boss.cancel(q.run, row.bossJobId);
    const fresh = await reload(db, row);
    if (fresh.state === 'queued') return readState(db, q, fresh, now);
    return { row: fresh };
  }
  await recordFailure(db, row, { kind: 'lost', message: 'the run job is gone' }, now);
  return { row: await reload(db, row) };
}
