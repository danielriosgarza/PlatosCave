import type { Scope } from '@parallax/contracts';
import type {
  Job,
  JobFetchOptions,
  JobPollingOptions,
  PgBoss,
  QueueOptions,
  SendOptions,
} from 'pg-boss';
import { z } from 'zod';
import {
  type ClassScope,
  type CourseScope,
  NoRecentAuthError,
  resolveActorScope,
  type ScopeFor,
} from '../auth/scope';
import type { Db } from '../db/client';

/** Jobs act on one class or one course; the rule is declared by the job, never by the payload. */
export type JobRule = Extract<Scope, { kind: 'class' } | { kind: 'course' }>;

export interface ScopedJobArgs<R extends JobRule, I extends z.ZodType> {
  /** Membership re-resolved when the job runs, not when it was enqueued. */
  scope: ScopeFor<R>;
  input: z.output<I>;
  db: Db;
  job: Job<unknown>;
}

export interface ScopedJob<R extends JobRule = JobRule, I extends z.ZodType = z.ZodType> {
  name: string;
  scope: R;
  input: I;
  queue?: QueueOptions;
  run: (args: ScopedJobArgs<R, I>) => Promise<object | undefined>;
}

export const defineScopedJob = <R extends JobRule, I extends z.ZodType>(
  job: ScopedJob<R, I>,
): ScopedJob<R, I> => job;

/** Every scoped job payload (ADR-0002): who acts, in which class or course, and the input. */
export const ScopedPayload = z.object({
  actorId: z.uuid(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('class'), classId: z.uuid() }),
    z.object({ kind: z.literal('course'), courseId: z.uuid() }),
  ]),
  input: z.unknown(),
});
export type ScopedPayload = z.infer<typeof ScopedPayload>;

/**
 * Enqueues a job for the person and class or course of an already resolved scope, so a job can
 * only be sent from code that itself passed the scope check. The input is stored as JSON and
 * parsed once when the job runs, so transforms run once; what is validated here is that JSON
 * form, the value the worker will parse, so an input that does not survive it (a `z.date()`, a
 * field set to `undefined` whose key the schema requires) fails now rather than at run time.
 * Resolves to null when pg-boss drops the send as a duplicate (`singletonKey`, throttling).
 */
export async function sendScopedJob<R extends JobRule, I extends z.ZodType>(
  boss: PgBoss,
  job: ScopedJob<R, I>,
  scope: ScopeFor<R>,
  input: z.input<I>,
  options: SendOptions = {},
): Promise<string | null> {
  const stored: unknown = JSON.parse(JSON.stringify(input) ?? 'null');
  job.input.parse(stored);
  const resolved = scope as ClassScope | CourseScope;
  const payload: ScopedPayload = {
    actorId: resolved.user.id,
    scope:
      job.scope.kind === 'class'
        ? { kind: 'class', classId: (resolved as ClassScope).classId }
        : { kind: 'course', courseId: (resolved as CourseScope).courseId },
    input: stored,
  };
  return boss.send(job.name, payload, options);
}

/**
 * Creates the job's queue, or brings an existing one in line with `job.queue`: `createQueue`
 * leaves an existing queue as it is, so changed options reach it only through `updateQueue`.
 * Options removed from `job.queue` keep their stored value (pg-boss merges updates).
 */
async function upsertQueue(boss: PgBoss, { name, queue }: Pick<ScopedJob, 'name' | 'queue'>) {
  await boss.createQueue(name, queue);
  if (queue && Object.keys(queue).length > 0) await boss.updateQueue(name, queue);
}

/**
 * Creates the queues of these jobs, so an API process can send before any worker has started.
 * Workers create their own queues in `workScopedJob`.
 */
export async function ensureQueues(boss: PgBoss, jobs: readonly ScopedJob[]): Promise<void> {
  for (const job of jobs) await upsertQueue(boss, job);
}

export type ScopedOutcome =
  | { status: 'completed'; output: object | undefined }
  | { status: 'refused'; reason: string };

const refuse = (reason: string): ScopedOutcome => ({ status: 'refused', reason });

/**
 * Runs one job for its actor (ADR-0002): rejects a payload without actor and scope, re-resolves
 * the actor's membership against the job's rule, and only then hands the handler a branded
 * scope. A refusal is final, including a handler calling `requireRecentAuth()`; any other error
 * thrown by the handler is left to pg-boss to retry.
 */
export async function runScopedJob<R extends JobRule, I extends z.ZodType>(
  db: Db,
  job: ScopedJob<R, I>,
  pgJob: Job<unknown>,
): Promise<ScopedOutcome> {
  const payload = ScopedPayload.safeParse(pgJob.data);
  if (!payload.success) return refuse('payload has no valid actorId and scope');
  const { actorId, scope, input } = payload.data;
  // Checked before any query: a payload of the wrong kind never reaches the database.
  if (scope.kind !== job.scope.kind) return refuse(`job needs ${job.scope.kind} scope`);

  const targetId = scope.kind === 'class' ? scope.classId : scope.courseId;
  const resolution = await resolveActorScope(db, actorId, job.scope, targetId);
  if (!resolution.ok) return refuse(resolution.reason);

  const parsed = job.input.safeParse(input);
  if (!parsed.success) return refuse('input does not match the job');
  try {
    const output = await job.run({
      scope: resolution.scope as ScopeFor<R>,
      input: parsed.data as z.output<I>,
      db,
      job: pgJob,
    });
    return { status: 'completed', output };
  } catch (err) {
    // `requireRecentAuth()` inside a job: a refusal, not an error worth retrying.
    if (err instanceof NoRecentAuthError) return refuse('a job cannot count as a recent sign-in');
    throw err;
  }
}

export interface WorkLogger {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Creates the job's queue and starts a worker for it. Refused jobs end terminally
 * (`deadletter`) with the reason as output, so a revoked membership is not retried. A job that
 * throws is settled `failed` on its own, so pg-boss retries it without re-running the rest of
 * its batch.
 */
export async function workScopedJob<R extends JobRule, I extends z.ZodType>(
  boss: PgBoss,
  db: Db,
  job: ScopedJob<R, I>,
  log: WorkLogger,
  polling: JobPollingOptions & Pick<JobFetchOptions, 'batchSize'> = {},
): Promise<string> {
  await upsertQueue(boss, job);
  return boss.work(job.name, { ...polling, perJobResults: true }, async (batch) => {
    const results = [];
    for (const pgJob of batch) {
      let outcome: ScopedOutcome;
      try {
        outcome = await runScopedJob(db, job, pgJob);
      } catch (err) {
        log.error({ job: job.name, jobId: pgJob.id, err }, 'job failed');
        const message = err instanceof Error ? err.message : String(err);
        results.push({ id: pgJob.id, status: 'failed' as const, output: { error: message } });
        continue;
      }
      if (outcome.status === 'refused') {
        log.warn({ job: job.name, jobId: pgJob.id, reason: outcome.reason }, 'job refused');
        results.push({
          id: pgJob.id,
          status: 'deadletter' as const,
          output: { refused: outcome.reason },
        });
      } else {
        results.push({ id: pgJob.id, status: 'completed' as const, output: outcome.output });
      }
    }
    return results;
  });
}
