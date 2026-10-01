import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ClassScope, CourseScope } from '../auth/scope';
import { loadClassTopics } from '../db/classTopics';
import type { Db } from '../db/client';
import { releaseResources, resourceRevisions, storageObjects } from '../db/schema';
import { openToStudent } from './availability';
import { draftSnapshot } from './releases';
import { type Disposition, keyInScope, mintContentToken } from './tokens';

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/x-ipynb+json': '.ipynb',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'text/csv': '.csv',
};

/**
 * Longest download base name in UTF-8 bytes: the name travels in the signed token, which must
 * stay under MAX_TOKEN_LENGTH even with long content types (minting refuses longer tokens).
 */
const MAX_NAME_BYTES = 120;

/** File name for a download: the resource title with filesystem-hostile characters removed. */
export function downloadName(title: string, contentType: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  let base = '';
  for (const char of cleaned) {
    if (Buffer.byteLength(base + char) > MAX_NAME_BYTES) break;
    base += char;
  }
  base = base.trim() || 'download';
  const ext = EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] ?? '';
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

export interface ContentUrlDeps {
  contentOrigin: string;
  secret: string;
  now: Date;
}

/** Key prefixes a scope may mint for: its own class area and its course's content. */
function scopeIdFor(scope: ClassScope | CourseScope, key: string): string {
  const owners = 'classId' in scope ? [scope.classId, scope.courseId] : [scope.courseId];
  const owner = owners.find((id) => keyInScope(key, id));
  if (!owner) throw new Error(`storage key ${key} is outside the request scope`);
  return owner;
}

/**
 * Signed, short-lived URL on the content origin for one object (ADR-0002). Takes a resolved
 * scope only; refuses keys outside that scope's prefixes.
 */
export function mintContentUrl(
  deps: ContentUrlDeps,
  scope: ClassScope | CourseScope,
  object: { key: string; contentType: string },
  options: { disposition: Disposition; filename?: string },
): { url: string; expiresAt: string } {
  const { token, exp } = mintContentToken(
    deps.secret,
    {
      key: object.key,
      userId: scope.user.id,
      scopeId: scopeIdFor(scope, object.key),
      contentType: object.contentType,
      disposition: options.disposition,
      ...(options.filename !== undefined && { filename: options.filename }),
    },
    deps.now,
  );
  return {
    url: `${deps.contentOrigin}/content/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * One object of a resource revision pinned in the class's adopted release, if the caller may
 * see that resource now: students only see visible resources whose release time has passed;
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
  if (scope.membership.isPreview) return findDraftObject(db, scope, revisionId, key, now);
  if (!scope.releaseId) return null;
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
  if (!(await topicOpens(db, scope, row.releaseTopicId, now))) return null;
  const { releaseTopicId: _topic, ...object } = row;
  return object;
}

/** The same availability the topic list shows: a locked topic's media is not downloadable (§4). */
async function topicOpens(db: Db, scope: ClassScope, releaseTopicId: string, now: Date) {
  if (scope.role !== 'student') return true;
  const { topics } = await loadClassTopics(db, scope, now);
  const topic = topics.find((t) => t.releaseTopicId === releaseTopicId);
  return topic?.availability.state === 'available' || topic?.availability.state === 'complete';
}

/**
 * The draft-preview counterpart of `findReleasedObject`: one object of a head revision in the
 * course draft snapshot, under the same student rules (ADR-0003).
 */
async function findDraftObject(
  db: Db,
  scope: ClassScope,
  revisionId: string,
  key: string,
  now: Date,
): Promise<{ key: string; contentType: string; title: string } | null> {
  const draft = await draftSnapshot(db, scope);
  const resource = draft.resources.find(
    (r) => r.revisionId === revisionId && (scope.role !== 'student' || openToStudent(r, now)),
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
  if (!row || !(await topicOpens(db, scope, resource.releaseTopicId, now))) return null;
  return { ...row, title: resource.title };
}
