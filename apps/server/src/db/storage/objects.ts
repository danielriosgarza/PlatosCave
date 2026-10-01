import type { CourseScope } from '../../auth/scope';
import type { StoredObject } from '../../storage/storage';
import type { Db } from '../client';
import { storageObjects } from '../schema';

/** Records a stored object of the scope's course once; recording the same key again is a no-op. */
export async function recordCourseObject(
  db: Db,
  scope: CourseScope,
  stored: StoredObject,
  contentType: string,
): Promise<void> {
  await db
    .insert(storageObjects)
    .values({ ...stored, courseId: scope.courseId, contentType, createdBy: scope.user.id })
    .onConflictDoNothing();
}
