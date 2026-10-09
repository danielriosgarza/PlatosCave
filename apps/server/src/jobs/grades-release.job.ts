import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type ClassScope, resolveActorScope } from '../auth/scope';
import { releaseScheduled } from '../db/grades';
import { assignmentOf } from '../db/tests';
import { defineScopedJob, sendScopedJob } from './scoped';

export const GRADES_RELEASE = 'grades.scheduled-release';

const rule = { kind: 'class', role: 'instructor' } as const;

/**
 * Releases a test's results at the time its terms schedule (§11): sent when a student starts an
 * attempt whose terms say `release.results: 'scheduled'`, to run at `release.at`. The student
 * cannot release grades, so the job runs as an instructor of the class: the one who last saved
 * the class's terms for the test, while they still teach it, else the class's stand-in
 * instructor. It releases what `releaseScheduled` finds due, so a duplicate, a retry or a late
 * run releases nothing twice and nothing saved after the scheduled time.
 */
const gradesRelease = defineScopedJob({
  name: GRADES_RELEASE,
  scope: rule,
  standIn: 'class_instructor',
  input: z.object({ resourceId: z.uuid() }),
  queue: { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  run: async ({ scope, input, db }) => {
    // An archived class is read-only (§13): its results stay as they are until it is restored.
    if (scope.archived) return { released: 0, skipped: [], archived: true };
    const editor = (await assignmentOf(db, scope, input.resourceId))?.updatedBy;
    let actor = scope;
    if (editor && editor !== scope.user.id) {
      const resolved = await resolveActorScope(db, editor, rule, scope.classId);
      if (resolved.ok) actor = resolved.scope as ClassScope;
    }
    const { release, skipped } = await releaseScheduled(db, actor, input.resourceId, new Date());
    return {
      releaseId: release?.id ?? null,
      releasedBy: release?.releasedBy ?? null,
      released: release?.recipients.length ?? 0,
      skipped,
    };
  },
});
export default gradesRelease;

/** Queues the scheduled release of a test's results in the student's class to run at `at`. */
export function enqueueScheduledRelease(
  boss: PgBoss,
  scope: ClassScope,
  resourceId: string,
  at: Date,
): Promise<string | null> {
  return sendScopedJob(boss, gradesRelease, scope, { resourceId }, { startAfter: at });
}
