import {
  RUNNER_FAILURE_KINDS,
  RunnerOutcome,
  type RunnerOutcome as RunnerOutcomeType,
  utf8Length,
} from '@parallax/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { Db, Tx } from '../client';
import { executionJobs, executionResults, type RunFailure, testAttempts } from '../schema';

/**
 * The writers of a run's terminal state (docs/design/runner.md §8.5): `recordOutcome` and
 * `recordFailure`, besides cancellation. Each moves a row only while it is `queued` or `running`,
 * through one conditional `UPDATE`, so the row lock orders concurrent writers and exactly one
 * wins; a settled row is never flipped by a later result, dead letter or read. They are used by
 * the worker's handlers and by read-time settlement (`status.ts`).
 */

export type RunRow = typeof executionJobs.$inferSelect;

const UNSETTLED = ['queued', 'running'] as const;
const MESSAGE_BYTES = 512;

/** Cuts text to at most `bytes` of UTF-8 without splitting a character. */
export function cutBytes(text: string, bytes = MESSAGE_BYTES): string {
  if (utf8Length(text) <= bytes) return text;
  let out = '';
  for (const char of text) {
    if (utf8Length(out + char) > bytes - 3) break;
    out += char;
  }
  return `${out}…`;
}

const KNOWN_KINDS = new Set<string>(RUNNER_FAILURE_KINDS);

/**
 * The failure output mapping (§8.5): the runner's `{ kind, message }` is kept; pg-boss's own
 * expiry output, and only it, is `expired`; any other output without a known kind is `unknown`
 * with its message, so a row never lacks a kind and `expired` names nothing but a timeout.
 */
export function mapFailure(output: unknown): RunFailure {
  const o = (output ?? {}) as { kind?: unknown; message?: unknown; value?: { message?: unknown } };
  if (typeof o.kind === 'string' && KNOWN_KINDS.has(o.kind)) {
    return { kind: o.kind, message: cutBytes(typeof o.message === 'string' ? o.message : '') };
  }
  const keys = output && typeof output === 'object' ? Object.keys(output) : [];
  if (
    keys.length === 1 &&
    o.value &&
    Object.keys(o.value).length === 1 &&
    o.value.message === 'job timed out'
  ) {
    return { kind: 'expired', message: 'job timed out' };
  }
  const message = o.value?.message ?? o.message ?? JSON.stringify(output ?? null);
  return { kind: 'unknown', message: cutBytes(String(message)) };
}

/**
 * NeedsReview for a grading run that ended without an outcome (§8.7): the attempt waits for an
 * instructor, who can replay it. Its student sees the distinct state (§11) and loses no attempt.
 */
async function needsReview(tx: Tx, row: RunRow): Promise<void> {
  if (row.reason !== 'grading' || !row.attemptId) return;
  await tx
    .update(testAttempts)
    .set({ state: 'needs_review' })
    .where(
      and(
        eq(testAttempts.id, row.attemptId),
        eq(testAttempts.classId, row.classId),
        inArray(testAttempts.state, ['submitted', 'grading']),
      ),
    );
}

/**
 * Records a runner outcome: the row takes the outcome's status and the result row is inserted.
 * `bossJob` is the `execution.run` job, for `started_at` and `infrastructure_attempts`; null
 * when it is already gone. Returns false when the row was already terminal (no effect).
 */
export async function recordOutcome(
  db: Db,
  row: RunRow,
  outcome: RunnerOutcomeType,
  bossJob: Pick<JobWithMetadata, 'startedOn' | 'retryCount'> | null,
  now: Date,
): Promise<boolean> {
  if (outcome.jobId !== row.id) throw new Error(`outcome for ${outcome.jobId} given to ${row.id}`);
  return db.transaction(async (tx) => {
    const [moved] = await tx
      .update(executionJobs)
      .set({
        state: outcome.status,
        finishedAt: now,
        startedAt: bossJob?.startedOn ?? null,
        infrastructureAttempts: bossJob?.retryCount ?? null,
      })
      .where(and(eq(executionJobs.id, row.id), inArray(executionJobs.state, UNSETTLED)))
      .returning({ id: executionJobs.id });
    if (!moved) return false;
    await tx
      .insert(executionResults)
      .values({
        jobId: row.id,
        classId: row.classId,
        userId: row.userId,
        attemptId: row.attemptId,
        questionRevisionId: row.questionRevisionId,
        questionId: row.questionId,
        checkSet: row.checkSet,
        reason: row.reason,
        codeHash: row.codeHash,
        status: outcome.status,
        imageId: outcome.image.id,
        imageDigest: outcome.image.digest,
        harnessVersion: outcome.result?.harnessVersion ?? row.harnessVersion,
        graderVersion: row.graderVersion,
        outcome: outcome as unknown as Record<string, unknown>,
        createdAt: now,
      })
      .onConflictDoNothing({ target: executionResults.jobId });
    return true;
  });
}

/**
 * Records an infrastructure failure: `infrastructure_error` with `failure = { kind, message }`
 * and, for a grading run, NeedsReview. `unsent` narrows the move to a row whose send was never
 * marked (the `enqueue_failed` decision of the read path, §8.5). A row already
 * `infrastructure_error` keeps its state and attempt; only a `lost` failure is replaced by a real
 * kind, which a dead letter worked after a `lost` read brings. Returns whether the row moved.
 */
export async function recordFailure(
  db: Db,
  row: RunRow,
  failure: RunFailure,
  now: Date,
  options: { unsent?: boolean } = {},
): Promise<boolean> {
  const value = { kind: failure.kind, message: cutBytes(failure.message) };
  return db.transaction(async (tx) => {
    const [moved] = await tx
      .update(executionJobs)
      .set({ state: 'infrastructure_error', failure: value, finishedAt: now })
      .where(
        and(
          eq(executionJobs.id, row.id),
          options.unsent
            ? and(eq(executionJobs.state, 'queued'), sql`${executionJobs.jobSentAt} is null`)
            : inArray(executionJobs.state, UNSETTLED),
        ),
      )
      .returning({ id: executionJobs.id });
    if (moved) {
      await needsReview(tx, row);
      return true;
    }
    if (value.kind !== 'lost' && value.kind !== 'enqueue_failed') {
      await tx
        .update(executionJobs)
        .set({ failure: value })
        .where(
          and(
            eq(executionJobs.id, row.id),
            eq(executionJobs.state, 'infrastructure_error'),
            sql`${executionJobs.failure}->>'kind' = 'lost'`,
          ),
        );
    }
    return false;
  });
}

/** A cancel that died between `bossExec.cancel` and its row update: the row is `cancelled`. */
export async function recordCancelled(db: Db, row: RunRow, now: Date): Promise<boolean> {
  const moved = await db
    .update(executionJobs)
    .set({ state: 'cancelled', finishedAt: now })
    .where(and(eq(executionJobs.id, row.id), inArray(executionJobs.state, UNSETTLED)))
    .returning({ id: executionJobs.id });
  return moved.length > 0;
}

/** A row by its id, for the worker's handlers, which act for no person (§8.4). */
async function rowById(db: Db, id: string): Promise<RunRow | undefined> {
  const [row] = await db.select().from(executionJobs).where(eq(executionJobs.id, id));
  return row;
}

export class UnknownRunError extends Error {}

/**
 * `execution.result` (§8.5): records the outcome from the message. An unknown id throws, so
 * pg-boss retries the message in case the row's transaction has not committed yet; a duplicate or
 * a message for a terminal row is completed without effect.
 */
export async function onResultMessage(
  db: Db,
  boss: PgBoss,
  runQueue: string,
  data: unknown,
  now: Date,
): Promise<'recorded' | 'ignored' | 'invalid'> {
  const parsed = RunnerOutcome.safeParse(data);
  if (!parsed.success) return 'invalid';
  const row = await rowById(db, parsed.data.jobId);
  if (!row) throw new UnknownRunError(`no run ${parsed.data.jobId} yet`);
  if (!UNSETTLED.includes(row.state as (typeof UNSETTLED)[number])) return 'ignored';
  const job = await boss.getJobById(runQueue, row.bossJobId);
  return (await recordOutcome(db, row, parsed.data, job, now)) ? 'recorded' : 'ignored';
}

/**
 * `execution.failed` (§8.5), read with `includeMetadata: true`: `data` is the failed `RunnerJob`,
 * `sourceOutput` its failure and `sourceId` the original run job. A dead letter whose source is
 * not the row's job is stale or forged and changes nothing.
 */
export async function onDeadLetter(
  db: Db,
  job: Pick<JobWithMetadata<unknown>, 'data' | 'sourceId' | 'sourceOutput'>,
  now: Date,
): Promise<'recorded' | 'ignored' | 'mismatch' | 'invalid'> {
  const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) return 'invalid';
  const row = await rowById(db, jobId);
  if (!row) throw new UnknownRunError(`no run ${jobId}`);
  if (row.bossJobId !== job.sourceId) return 'mismatch';
  return (await recordFailure(db, row, mapFailure(job.sourceOutput), now)) ? 'recorded' : 'ignored';
}
