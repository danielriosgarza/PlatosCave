import { and, eq } from 'drizzle-orm';
import type { CourseScope } from '../../auth/scope';
import type { StoredObject } from '../../storage/storage';
import type { Db } from '../client';
import { storageObjects } from '../schema';
import { forCourse } from '../scoped';

/** The type of bytes stored without one of their own, such as a workspace file. */
export const GENERIC_CONTENT_TYPE = 'application/octet-stream';

/**
 * Records a stored object of the scope's course once. Recording the same key again changes
 * nothing, except that a specific type replaces the generic one: bytes first stored as a
 * workspace file and later uploaded as a PDF reading are then served as a PDF. The first
 * specific type stays.
 */
export async function recordCourseObject(
  db: Db,
  scope: CourseScope,
  stored: StoredObject,
  contentType: string,
): Promise<void> {
  const insert = db
    .insert(storageObjects)
    .values({ ...stored, courseId: scope.courseId, contentType, createdBy: scope.user.id });
  if (contentType === GENERIC_CONTENT_TYPE) {
    await insert.onConflictDoNothing();
    return;
  }
  await insert.onConflictDoUpdate({
    target: storageObjects.key,
    set: { contentType },
    setWhere: eq(storageObjects.contentType, GENERIC_CONTENT_TYPE),
  });
}

/** The id of the course's recorded object with this key; null when there is none. */
export async function courseObjectId(
  db: Db,
  scope: CourseScope,
  key: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: storageObjects.id })
    .from(storageObjects)
    .where(and(forCourse(scope, storageObjects), eq(storageObjects.key, key)));
  return row?.id ?? null;
}
