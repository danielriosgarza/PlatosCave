import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ClassScope, CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { releaseResources, resourceRevisions, storageObjects } from '../db/schema';
import { type Disposition, mintContentToken } from './tokens';

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/x-ipynb+json': '.ipynb',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'text/csv': '.csv',
};

/** Longest download base name, in characters: keeps signed tokens well under the router limit. */
const MAX_NAME = 100;

/** File name for a download: the resource title with filesystem-hostile characters removed. */
export function downloadName(title: string, contentType: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  const base = [...cleaned].slice(0, MAX_NAME).join('').trim() || 'download';
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
  const owner = owners.find(
    (id) => key.startsWith(`courses/${id}/`) || key.startsWith(`classes/${id}/`),
  );
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
 * instructors see every resource of the release. Anything else is null (the route answers 404).
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
  return row ?? null;
}
