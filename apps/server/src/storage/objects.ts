import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { storageObjects } from '../db/schema';
import { type Body, courseObjectPrefix, type Storage, type StoredObject } from './storage';

/**
 * Streams bytes into the course's content-addressed area and records the object once;
 * storing identical bytes again returns the same key without a second row.
 */
export async function storeCourseObject(
  db: Db,
  storage: Storage,
  scope: CourseScope,
  body: Body,
  contentType: string,
): Promise<StoredObject> {
  const stored = await storage.put(courseObjectPrefix(scope.courseId), body);
  await db
    .insert(storageObjects)
    .values({ ...stored, courseId: scope.courseId, contentType, createdBy: scope.user.id })
    .onConflictDoNothing();
  return stored;
}
