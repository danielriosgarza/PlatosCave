import { type AssignmentSettings, testAttemptStates } from '@parallax/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { resourceRevisions, resources } from './content';
import { classes } from './memberships';
import { users } from './users';

/**
 * Tests as a class assigns them (§11, §13). An assignment is one class's settings for one test
 * resource (the draft resource, so it survives adopting a new release); attempts pin the
 * revision and grader version they started on (A16), and a submission is an immutable snapshot
 * of the attempt's last acknowledged answers with the receipt the student was given (A14, A15).
 */
export const testAttemptState = pgEnum('test_attempt_state', testAttemptStates);

export const assignments = pgTable(
  'assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    /** The class's overrides of the revision's settings (`assignmentSettingsPatch`). */
    settings: jsonb().$type<Partial<AssignmentSettings>>().notNull().default({}),
    /** Optimistic-concurrency counter for settings edits (§12: never overwrite silently). */
    revision: integer().notNull().default(1),
    updatedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.id, t.classId), unique().on(t.classId, t.resourceId)],
);

/**
 * An instructor's extension or extra attempt for one student, with its reason (§11). Each grant
 * states the whole override; the latest one is in force and earlier ones stay as history (a
 * trigger rejects updates and direct deletes).
 */
export const assignmentOverrides = pgTable(
  'assignment_overrides',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    assignmentId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    extraAttempts: integer().notNull().default(0),
    extraMinutes: integer().notNull().default(0),
    /** A personal closing time replacing the class's (an explicit extension). */
    closesAt: timestamp({ withTimezone: true }),
    reason: text().notNull(),
    grantedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'assignment_overrides_assignment_fk',
      columns: [t.assignmentId, t.classId],
      foreignColumns: [assignments.id, assignments.classId],
    }).onDelete('cascade'),
    index().on(t.assignmentId, t.userId, t.createdAt),
    check('assignment_overrides_extra', sql`${t.extraAttempts} >= 0 and ${t.extraMinutes} >= 0`),
    check('assignment_overrides_reason', sql`length(trim(${t.reason})) > 0`),
  ],
);

export const testAttempts = pgTable(
  'test_attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    assignmentId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Written by a preview principal; review excludes it. */
    isPreview: boolean().notNull().default(false),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    /** The question revision the attempt started on; it never changes (A16). */
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    /** Hash of the revision's grading material (answer keys, checks, rubric, points). */
    graderVersion: text().notNull(),
    /** 1 for the first attempt, then one more per retake. */
    number: integer().notNull(),
    state: testAttemptState().notNull().default('in_progress'),
    /** The effective terms when the attempt started, the student's override included. */
    settings: jsonb().$type<AssignmentSettings>().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** When the server submits the latest acknowledged answers; null when nothing closes it. */
    deadlineAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }),
    /**
     * Work the student's browser still held after the attempt closed, kept for an instructor
     * recovery request (§11). Never part of the submission.
     */
    localCopy: jsonb().$type<Record<string, unknown>>(),
    localCopyAt: timestamp({ withTimezone: true }),
    /** The attempt an instructor chose to report under the `instructor_selected` rule. */
    reportSelected: boolean().notNull().default(false),
  },
  (t) => [
    unique().on(t.id, t.classId),
    unique().on(t.classId, t.userId, t.resourceId, t.number),
    uniqueIndex('test_attempts_report_selected')
      .on(t.classId, t.userId, t.resourceId)
      .where(sql`${t.reportSelected}`),
    uniqueIndex('test_attempts_open')
      .on(t.classId, t.userId, t.resourceId)
      .where(sql`${t.state} = 'in_progress'`),
    index().on(t.classId, t.resourceId),
    foreignKey({
      name: 'test_attempts_assignment_fk',
      columns: [t.assignmentId, t.classId],
      foreignColumns: [assignments.id, assignments.classId],
    }),
    check(
      'test_attempts_submitted',
      sql`(${t.state} = 'in_progress') = (${t.submittedAt} is null)`,
    ),
    check('test_attempts_number', sql`${t.number} >= 1`),
  ],
);

/**
 * The latest acknowledged answer to each question of an open attempt (autosave). `seq` is the
 * client's counter for the question, so a delayed older save never replaces a newer one. A
 * trigger refuses writes once the attempt has left `in_progress`.
 */
export const attemptAnswers = pgTable(
  'attempt_answers',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    attemptId: uuid().notNull(),
    questionId: text().notNull(),
    value: jsonb().$type<unknown>(),
    flagged: boolean().notNull().default(false),
    seq: integer().notNull(),
    savedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'attempt_answers_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    unique().on(t.attemptId, t.questionId),
  ],
);

/** One frozen answer of a submission, as the receipt names it. */
export interface SubmittedAnswer {
  questionId: string;
  value: unknown;
  flagged: boolean;
  seq: number;
  savedAt: string;
}

/**
 * The immutable snapshot of a submitted attempt (a trigger rejects updates and direct deletes).
 * A student's submission carries their idempotency key; a deadline submission has none and is
 * marked `auto_submitted`.
 */
export const testSubmissions = pgTable(
  'test_submissions',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    attemptId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionKey: text(),
    answers: jsonb().$type<SubmittedAnswer[]>().notNull(),
    autoSubmitted: boolean().notNull(),
    /** Received after the class's (or the student's extended) closing time. */
    late: boolean().notNull(),
    submittedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'test_submissions_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    unique().on(t.attemptId),
    unique().on(t.classId, t.userId, t.submissionKey),
    check('test_submissions_key', sql`${t.autoSubmitted} = (${t.submissionKey} is null)`),
  ],
);
