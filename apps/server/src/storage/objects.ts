import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { recordCourseObject } from '../db/storage/objects';
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
  await recordCourseObject(db, scope, stored, contentType);
  return stored;
}
