import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { releaseOpen } from '../db/grades';
import { defineScopedJob, sendScopedJob } from './scoped';

export const GRADES_OPEN_RELEASE = 'grades.open-release';

/** While a code question's grading run is queued or running, the job looks again this much later. */
const PENDING_RETRY_MS = 60_000;
/** How many times it looks again: half an hour, then the attempt waits as any ungraded one does. */
const PENDING_ROUNDS = 30;

/**
 * Releases a submitted attempt's automated score in an open class (§13, N10), where nobody
 * grades. Sent when the attempt is submitted, by its student or at its deadline. Releasing grades
 * is an instructor's action, so the job runs as the class's stand-in instructor; no instructor
 * acts. `releaseOpen` does nothing in a class that is not open, so a class closed again since the
 * send is left to its instructors, and nothing is released twice.
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
  const later = round > 0 ? { startAfter: new Date(Date.now() + PENDING_RETRY_MS) } : {};
  return sendScopedJob(boss, gradesOpenRelease, scope, { attemptId, round }, later);
}
