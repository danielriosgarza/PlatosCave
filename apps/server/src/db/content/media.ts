import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ClassScope } from '../../auth/scope';
import { findReleaseTopic } from '../classTopics';
import type { Db } from '../client';
import { releaseResources, resourceRevisions, storageObjects } from '../schema';

/**
 * One object of a resource revision pinned in the class's adopted release, if the caller may
 * see that resource now: students only see visible resources whose release time has passed;
 * instructors see every resource of the release. Students also need the topic to be open
 * (not prerequisite-locked or still scheduled). Anything else is null (the route answers 404).
 */
export async function findReleasedObject(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  key: string,
  now: Date,
): Promise<{ key: string; contentType: string; title: string } | null> {
  if (!scope.releaseId || !key.startsWith(`courses/${scope.courseId}/`)) return null;
  const studentView =
    scope.role === 'student'
      ? and(
          eq(releaseResources.visibility, 'visible'),
          or(isNull(releaseResources.releaseAt), lte(releaseResources.releaseAt, now)),
        )
      : undefined;
  const [row] = await db
    .select({
      key: storageObjects.key,
      contentType: storageObjects.contentType,
      title: releaseResources.title,
      releaseTopicId: releaseResources.releaseTopicId,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .innerJoin(
      storageObjects,
      and(eq(storageObjects.key, key), eq(storageObjects.courseId, resourceRevisions.courseId)),
    )
    .where(
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(releaseResources.resourceRevisionId, revisionId),
        eq(resourceRevisions.courseId, scope.courseId),
        sql`${key} = any(${resourceRevisions.objectKeys})`,
        studentView,
      ),
    )
    .limit(1);
  if (!row) return null;
  // The same availability the topic list shows: a locked topic's media is not downloadable (§4).
  const topic = await findReleaseTopic(db, scope, { releaseTopicId: row.releaseTopicId }, now);
  if (!topic?.open) return null;
  const { releaseTopicId: _topic, ...object } = row;
  return object;
}
