import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type {
  ClassContext,
  ClassScope,
  CourseContext,
  DraftPreviewScope,
  UserScope,
} from '../auth/scope';
import {
  annotationPlacements,
  annotations,
  assignmentOverrides,
  assignments,
  attemptAnswers,
  cellExecutions,
  classComputeTemplates,
  classes,
  classInvites,
  classMemberships,
  classReleaseHistory,
  connectorPairings,
  connectors,
  courseMemberships,
  courseReleases,
  executionJobs,
  executionResults,
  exerciseAttempts,
  exerciseEvents,
  fileTransfers,
  notebookConnections,
  notebookSessions,
  notebookSubmissionFiles,
  notebookSubmissions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  posts,
  resourceRevisions,
  resources,
  storageObjects,
  studyPositions,
  testAttempts,
  testSubmissions,
  threads,
  topicReviews,
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
  notebookSubmissions,
  topicReviews,
  classComputeTemplates,
  assignments,
  assignmentOverrides,
  testAttempts,
  attemptAnswers,
  testSubmissions,
  notebookSessions,
  cellExecutions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  fileTransfers,
  notebookSubmissionFiles,
  executionJobs,
  executionResults,
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

/**
 * Tables holding one person's own records (`owner_user_id`), not class data: connectors, their
 * pairing codes and saved connections (docs/design/connector.md §10.2). scoped.test.ts fails when
 * a table with that column is missing here. `connectors.owner_user_id` is null for a managed
 * connector, which `forUser` therefore never returns.
 */
export const userOwnedTables = [connectors, connectorPairings, notebookConnections] as const;
type UserOwnedTable = (typeof userOwnedTables)[number];

/** `WHERE owner_user_id = …` for a user-owned table; takes only a resolved user scope. */
export const forUser = (scope: UserScope, table: UserOwnedTable): SQL =>
  eq(table.ownerUserId, scope.user.id);

/**
 * Class-scoped tables a user's own rows may be read from across classes, the recorded exception
 * to ADR-0002 (docs/design/runner.md §8.4): the per-student run cap is a property of the student,
 * not of one class. scoped.test.ts pins this list.
 */
export const ownRowsTables = [executionJobs] as const;
type OwnRowsTable = (typeof ownRowsTables)[number];

/**
 * `WHERE user_id = …` over every class: the rows the user of a resolved class scope owns. It
 * takes the scope rather than an id, so it can name no one but the caller, and is for reads only;
 * a row is changed only under its own class scope.
 */
export const forOwnRows = (scope: ClassScope, table: OwnRowsTable): SQL =>
  eq(table.userId, scope.user.id);

/** `WHERE class_id = …` for a class-scoped table; takes only a resolved scope, never a raw id. */
export const forClass = (scope: ClassContext, table: { classId: PgColumn }): SQL =>
  eq(table.classId, scope.classId);

/**
 * `WHERE course_id = …` for a course-scoped table; takes only a resolved course or class-manager
 * scope.
 */
export const forCourse = (scope: CourseContext, table: { courseId: PgColumn }): SQL =>
  eq(table.courseId, scope.courseId);

/**
 * `WHERE course_id = …` for a draft preview reading the draft it previews (ADR-0003). It takes
 * only the draft syllabus tables, so a class-scoped function narrowed with `isDraftPreview`
 * cannot reach any other course-scoped table; ADR-0003 grants a preview a read, so use it in
 * reads only.
 */
export const forDraftCourse = (
  scope: DraftPreviewScope,
  table: typeof topics | typeof resources,
): SQL => eq(table.courseId, scope.courseId);
