import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { expireAttempt } from '../db/tests';
import { defineScopedJob, sendScopedJob } from './scoped';

export const TESTS_EXPIRE = 'tests.expire-attempt';

/**
 * Submits an attempt at its deadline from its last acknowledged answers (§11, A15). Sent when an
 * attempt starts (as its student) and when an extension moves its deadline (as the instructor);
 * it runs again at the new deadline while the attempt stays open. Every read of the attempt
 * settles it too, so a late or lost job never leaves it open past its deadline.
 */
const testsExpire = defineScopedJob({
  name: TESTS_EXPIRE,
  scope: { kind: 'class', role: 'any' },
  input: z.object({ attemptId: z.uuid() }),
  queue: { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db, boss }) => {
    const now = new Date();
    const result = await expireAttempt(db, scope, input.attemptId, now);
    if (result.deadlineAt && result.deadlineAt > now && boss) {
      await enqueueTestsExpire(boss, scope, input.attemptId, result.deadlineAt);
    }
    return { state: result.state, deadlineAt: result.deadlineAt?.toISOString() ?? null };
  },
});
export default testsExpire;

/** Queues the deadline job for an attempt to run at `deadlineAt`. */
export function enqueueTestsExpire(
  boss: PgBoss,
  scope: ClassScope,
  attemptId: string,
  deadlineAt: Date,
): Promise<string | null> {
  return sendScopedJob(boss, testsExpire, scope, { attemptId }, { startAfter: deadlineAt });
}
