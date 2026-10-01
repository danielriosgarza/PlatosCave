import type { Scope } from '@parallax/contracts';
import { eq } from 'drizzle-orm';
import type { Job, JobPollingOptions, PgBoss, QueueOptions, SendOptions } from 'pg-boss';
import { z } from 'zod';
import {
  type ClassScope,
  type CourseScope,
  type Resolution,
  resolveClass,
  resolveCourse,
  type ScopeBase,
  type ScopeFor,
} from '../auth/scope';
import type { Db } from '../db/client';
import { users } from '../db/schema';

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
 * only be sent from code that itself passed the scope check.
 */
export async function sendScopedJob<R extends JobRule, I extends z.ZodType>(
  boss: PgBoss,
  job: ScopedJob<R, I>,
  scope: ScopeFor<R>,
  input: z.input<I>,
  options: SendOptions = {},
): Promise<string> {
  const resolved = scope as ClassScope | CourseScope;
  const payload: ScopedPayload = {
    actorId: resolved.user.id,
    scope:
      job.scope.kind === 'class'
        ? { kind: 'class', classId: (resolved as ClassScope).classId }
        : { kind: 'course', courseId: (resolved as CourseScope).courseId },
    input: job.input.parse(input),
  };
  const id = await boss.send(job.name, payload, options);
  if (!id) throw new Error(`pg-boss did not accept a ${job.name} job`);
  return id;
}

export type ScopedOutcome =
  | { status: 'completed'; output: object | undefined }
  | { status: 'refused'; reason: string };

const refuse = (reason: string): ScopedOutcome => ({ status: 'refused', reason });

/** Jobs run without a session, so nothing they do can count as a recent sign-in (§3). */
function jobBase(user: ScopeBase['user']): ScopeBase {
  return {
    user,
    requireRecentAuth: () => {
      throw Object.assign(new Error('Background jobs cannot make sensitive changes'), {
        code: 'recent_auth_required',
      });
    },
  };
}

/**
 * Runs one job for its actor (ADR-0002): rejects a payload without actor and scope, re-resolves
 * the actor's membership against the job's rule, and only then hands the handler a branded
 * scope. A refusal is final; an error thrown by the handler is left to pg-boss to retry.
 */
export async function runScopedJob<R extends JobRule, I extends z.ZodType>(
  db: Db,
  job: ScopedJob<R, I>,
  pgJob: Job<unknown>,
): Promise<ScopedOutcome> {
  const payload = ScopedPayload.safeParse(pgJob.data);
  if (!payload.success) return refuse('payload has no valid actorId and scope');
  const { actorId, scope, input } = payload.data;

  const [actor] = await db
    .select({
      id: users.id,
      kind: users.kind,
      name: users.name,
      email: users.email,
      ownerUserId: users.ownerUserId,
    })
    .from(users)
    .where(eq(users.id, actorId));
  if (!actor) return refuse('actor does not exist');

  const base = jobBase(actor);
  let resolution: Resolution;
  if (scope.kind === 'class' && job.scope.kind === 'class') {
    resolution = await resolveClass(db, base, job.scope, scope.classId);
  } else if (scope.kind === 'course' && job.scope.kind === 'course') {
    resolution = await resolveCourse(db, base, job.scope, scope.courseId);
  } else {
    return refuse(`job needs ${job.scope.kind} scope`);
  }
  if (!resolution.ok) return refuse(resolution.reason);

  const parsed = job.input.safeParse(input);
  if (!parsed.success) return refuse('input does not match the job');
  const output = await job.run({
    scope: resolution.scope as ScopeFor<R>,
    input: parsed.data as z.output<I>,
    db,
    job: pgJob,
  });
  return { status: 'completed', output };
}

export interface WorkLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * Creates the job's queue and starts a worker for it. Refused jobs end terminally
 * (`deadletter`) with the reason as output, so a revoked membership is not retried.
 */
export async function workScopedJob<R extends JobRule, I extends z.ZodType>(
  boss: PgBoss,
  db: Db,
  job: ScopedJob<R, I>,
  log: WorkLogger,
  polling: JobPollingOptions = {},
): Promise<string> {
  await boss.createQueue(job.name, job.queue);
  return boss.work(job.name, { ...polling, perJobResults: true }, async (batch) => {
    const results = [];
    for (const pgJob of batch) {
      const outcome = await runScopedJob(db, job, pgJob);
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
