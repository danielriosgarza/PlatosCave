import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ClassContext, CourseContext } from '../auth/scope';
import {
  annotationPlacements,
  annotations,
  classes,
  classInvites,
  classMemberships,
  classReleaseHistory,
  courseMemberships,
  courseReleases,
  exerciseAttempts,
  exerciseEvents,
  posts,
  resourceRevisions,
  resources,
  storageObjects,
  studyPositions,
  threads,
  topics,
} from './schema';

/**
 * Tables holding one class's data (`class_id NOT NULL`) and one course's data
 * (`course_id NOT NULL`). scoped.test.ts introspects the schema and fails when a table with
 * such a column is missing here, or a listed table lacks it (ADR-0002).
 */
export const classScopedTables: PgTable[] = [
  classMemberships,
  classInvites,
  classReleaseHistory,
  studyPositions,
  annotations,
  threads,
  posts,
  annotationPlacements,
  exerciseAttempts,
  exerciseEvents,
];
export const courseScopedTables: PgTable[] = [
  classes,
  courseMemberships,
  topics,
  resources,
  resourceRevisions,
  courseReleases,
  storageObjects,
];

/** `WHERE class_id = …` for a class-scoped table; takes only a resolved scope, never a raw id. */
export const forClass = (scope: ClassContext, table: { classId: PgColumn }): SQL =>
  eq(table.classId, scope.classId);

/** `WHERE course_id = …` for a course-scoped table; takes only a resolved scope. */
export const forCourse = (scope: CourseContext, table: { courseId: PgColumn }): SQL =>
  eq(table.courseId, scope.courseId);
