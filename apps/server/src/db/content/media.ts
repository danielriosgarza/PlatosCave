import { and, eq, sql } from 'drizzle-orm';
import { type ClassScope, type DraftPreviewScope, isDraftPreview } from '../../auth/scope';
import { findReleaseTopic } from '../classTopics';
import type { Db } from '../client';
import { releaseResources, resourceRevisions, storageObjects } from '../schema';
import { type DraftSnapshot, draftSnapshot, studyableDraft, studyOpen } from './releases';

/**
 * One object of a resource revision pinned in the class's adopted release, if the caller may
 * see that resource now: students only see resources that are not hidden and whose release time has passed (`studyOpen`);
 * instructors see every resource of the release. Students also need the topic to be open
 * (not prerequisite-locked or still scheduled). Anything else is null (the route answers 404).
 * A draft preview finds objects of the draft snapshot instead, under the same rules.
 */
export async function findReleasedObject(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  key: string,
  now: Date,
): Promise<{ key: string; contentType: string; title: string } | null> {
  if (!key.startsWith(`courses/${scope.courseId}/`)) return null;
  if (isDraftPreview(scope)) return findDraftObject(db, scope, revisionId, key, now);
  if (!scope.releaseId) return null;
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
        studyOpen(scope, now),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (!(await topicOpens(db, scope, row.releaseTopicId, now))) return null;
  const { releaseTopicId: _topic, ...object } = row;
  return object;
}

/** The same availability the topic list shows: a locked topic's media is not downloadable (§4). */
async function topicOpens(
  db: Db,
  scope: ClassScope,
  releaseTopicId: string,
  now: Date,
  draft?: DraftSnapshot,
) {
  // The row came from the caller's release or draft, so for an instructor its topic is open.
  if (scope.role !== 'student') return true;
  return (await findReleaseTopic(db, scope, { releaseTopicId }, now, draft))?.open ?? false;
}

/**
 * The draft-preview counterpart of `findReleasedObject`: one object of a head revision in the
 * course draft snapshot, under the same student rules (ADR-0003).
 */
async function findDraftObject(
  db: Db,
  scope: DraftPreviewScope,
  revisionId: string,
  key: string,
  now: Date,
): Promise<{ key: string; contentType: string; title: string } | null> {
  // Read once: the topic gate below judges availability from the same snapshot.
  const draft = await draftSnapshot(db, scope);
  const resource = (await studyableDraft(db, scope, now, draft)).find(
    (r) => r.revisionId === revisionId,
  );
  if (!resource) return null;
  const [row] = await db
    .select({ key: storageObjects.key, contentType: storageObjects.contentType })
    .from(resourceRevisions)
    .innerJoin(
      storageObjects,
      and(eq(storageObjects.key, key), eq(storageObjects.courseId, resourceRevisions.courseId)),
    )
    .where(
      and(
        eq(resourceRevisions.id, revisionId),
        eq(resourceRevisions.courseId, scope.courseId),
        sql`${key} = any(${resourceRevisions.objectKeys})`,
      ),
    )
    .limit(1);
  if (!row || !(await topicOpens(db, scope, resource.releaseTopicId, now, draft))) return null;
  return { ...row, title: resource.title };
}
