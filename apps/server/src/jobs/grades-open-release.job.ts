import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { releaseOpen } from '../db/grades';
import { defineScopedJob, sendScopedJob } from './scoped';

export const GRADES_OPEN_RELEASE = 'grades.open-release';

/** While a code question is still being graded, the job looks again: a minute, doubling to a day. */
const PENDING_RETRY_MS = 60_000;
const PENDING_RETRY_MAX_MS = 24 * 60 * 60_000;
/** How many times it looks again: for ten days, then the attempt waits as any ungraded one does. */
const PENDING_ROUNDS = 20;

/**
 * Releases a submitted attempt's automated score in an open class (§13, N10), where nobody
 * grades (`releaseOpen`). Sent as the student on submit and at the deadline; releasing is an
 * instructor's action, so it runs as the class's stand-in instructor. A refused step throws: the
 * worker logs it and the queue runs the job again, which finishes a grade saved but not released.
 */
const gradesOpenRelease = defineScopedJob({
  name: GRADES_OPEN_RELEASE,
  scope: { kind: 'class', role: 'instructor' },
  standIn: 'class_instructor',
  input: z.object({ attemptId: z.uuid(), round: z.number().int().min(0).default(0) }),
  queue: { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db, boss }) => {
    const { release, pending } = await releaseOpen(db, scope, input.attemptId, new Date());
    if (pending && boss && input.round < PENDING_ROUNDS) {
      await enqueueOpenRelease(boss, scope, input.attemptId, input.round + 1);
    }
    return { releaseId: release?.id ?? null, released: release?.recipients.length ?? 0, pending };
  },
});
export default gradesOpenRelease;

/** Queues the automatic release of a submitted attempt in an open class; a later round waits. */
export function enqueueOpenRelease(
  boss: PgBoss,
  scope: ClassScope,
  attemptId: string,
  round = 0,
): Promise<string | null> {
  const wait = Math.min(PENDING_RETRY_MS * 2 ** (round - 1), PENDING_RETRY_MAX_MS);
  const later = round > 0 ? { startAfter: new Date(Date.now() + wait) } : {};
  return sendScopedJob(boss, gradesOpenRelease, scope, { attemptId, round }, later);
}
