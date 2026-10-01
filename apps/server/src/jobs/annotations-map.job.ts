import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { mapClass } from '../annotations/annotations';
import type { ClassScope } from '../auth/scope';
import { defineScopedJob, sendScopedJob } from './scoped';

export const ANNOTATIONS_MAP = 'annotations.map';

/** Thrown while a pinned revision's derived outputs are not ready, so pg-boss runs it again. */
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

/** Creates the job's queue; the API calls this once at startup, before any adoption sends. */
export const createAnnotationsMapQueue = (boss: PgBoss) =>
  boss.createQueue(annotationsMap.name, annotationsMap.queue);

/** Queues mapping for the class's newly adopted release. */
export function enqueueAnnotationsMap(
  boss: PgBoss,
  scope: ClassScope,
  releaseId: string,
): Promise<string> {
  return sendScopedJob(boss, annotationsMap, scope, { releaseId });
}
