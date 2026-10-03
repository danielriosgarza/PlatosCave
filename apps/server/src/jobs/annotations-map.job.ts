import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { type ClassScope, type CourseScope, resolveActorScope } from '../auth/scope';
import { mapClass } from '../db/annotations/annotations';
import type { Db } from '../db/client';
import { adoptersPinningResourceOf } from '../db/content/adoption';
import { defineScopedJob, sendScopedJob } from './scoped';

export const ANNOTATIONS_MAP = 'annotations.map';

/**
 * Thrown while a pinned revision's derived outputs are not ready, so pg-boss runs it again.
 * Marks still pending once the retries are spent are mapped by the run that ingestion queues
 * when those outputs are written (`requeueAnnotationsMap`).
 */
export class MappingPending extends Error {}

/**
 * Maps the class's annotations and threads onto the revisions of its adopted release
 * (ADR-0003). Runs as the instructor who adopted; marks on revisions still being converted
 * are left for a retry.
 */
const annotationsMap = defineScopedJob({
  name: ANNOTATIONS_MAP,
  scope: { kind: 'class', role: 'instructor' },
  input: z.object({ releaseId: z.uuid() }),
  queue: { retryLimit: 5, retryDelay: 60, retryBackoff: true },
  run: async ({ scope, input, db }) => {
    // A later adoption queues its own run; this one has nothing left to do.
    if (scope.releaseId !== input.releaseId) return { skipped: 'release changed' };
    const result = await mapClass(db, scope);
    if (result.pending > 0) {
      throw new MappingPending(`${result.pending} marks wait for converted revisions`);
    }
    return result;
  },
});
export default annotationsMap;

/**
 * Queues mapping for the class's newly adopted release. The API creates the queue at startup
 * (`ensureQueues` in main.ts). Null when pg-boss drops the send as a duplicate.
 */
export function enqueueAnnotationsMap(
  boss: PgBoss,
  scope: ClassScope,
  releaseId: string,
): Promise<string | null> {
  return sendScopedJob(boss, annotationsMap, scope, { releaseId });
}

/**
 * Queues mapping again for every class whose adopted release pins a revision of the resource
 * that `revisionId` belongs to, once that revision's derived outputs are final (ready or
 * failed), so marks left pending after the mapping job's retries are placed. Each run is sent
 * as the instructor who adopted the release, whose membership is resolved first (ADR-0002); a
 * class whose adopter is no longer its instructor is skipped. Returns the number of jobs sent.
 */
export async function requeueAnnotationsMap(
  boss: PgBoss,
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<number> {
  let sent = 0;
  for (const { classId, releaseId, actorId } of await adoptersPinningResourceOf(
    db,
    scope,
    revisionId,
  )) {
    const resolved = await resolveActorScope(db, actorId, annotationsMap.scope, classId);
    if (!resolved.ok) continue;
    const classScope = resolved.scope as ClassScope;
    // A newer adoption by someone else queued its own mapping run.
    if (classScope.releaseId !== releaseId) continue;
    if (await enqueueAnnotationsMap(boss, classScope, releaseId)) sent += 1;
  }
  return sent;
}
