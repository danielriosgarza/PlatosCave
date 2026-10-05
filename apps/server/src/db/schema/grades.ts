import type { AutomatedScore, FeedbackItem, ManualScore } from '@parallax/contracts/routes/grades';
import { gradeSources, gradeStates } from '@parallax/contracts/routes/grades';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { resourceRevisions, resources } from './content';
import { classes } from './memberships';
import { testAttempts } from './tests';
import { users } from './users';

/**
 * Grades of test attempts (§11, §12, §13). `grades` is an append-only history per attempt: a
 * draft save, a regrade and an override each add a row, and a trigger allows one change to a
 * stored row, its release (draft → released with its release id and time). An override row
 * names the prior grade it replaced, which stays as it was (A18). A release records its actor,
 * time and the exact recipients (A17).
 */

export const gradeState = pgEnum('grade_state', gradeStates);
export const gradeSource = pgEnum('grade_source', gradeSources);

/** One question's parts as graded; the row's question list follows the pinned revision. */
export interface GradedQuestion {
  questionId: string;
  possible: number;
  automated: AutomatedScore | null;
  manual: ManualScore | null;
  points: number | null;
}

export interface ReleaseRecipientRow {
  studentId: string;
  attemptId: string;
  gradeId: string;
}

export const gradeReleases = pgTable(
  'grade_releases',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    releasedBy: uuid()
      .notNull()
      .references(() => users.id),
    releasedAt: timestamp({ withTimezone: true }).notNull(),
    recipients: jsonb().$type<ReleaseRecipientRow[]>().notNull(),
  },
  (t) => [unique().on(t.id, t.classId), index().on(t.classId, t.releasedAt)],
);

export const grades = pgTable(
  'grades',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    attemptId: uuid().notNull(),
    /** The student whose attempt it grades. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    /** The attempt's pinned revision: the rubric and answer keys the grade applies. */
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    graderVersion: text().notNull(),
    number: integer().notNull(),
    state: gradeState().notNull().default('draft'),
    source: gradeSource().notNull(),
    reason: text(),
    questions: jsonb().$type<GradedQuestion[]>().notNull(),
    feedback: jsonb().$type<FeedbackItem[]>().notNull(),
    automatedPoints: doublePrecision().notNull(),
    manualPoints: doublePrecision().notNull(),
    /** The override in force; later rows of the attempt carry it forward. */
    overrideId: uuid().references((): AnyPgColumn => gradeOverrides.id),
    /** The grade: the override's points, or automated plus manual. */
    points: doublePrecision().notNull(),
    possible: doublePrecision().notNull(),
    complete: boolean().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    releaseId: uuid(),
    releasedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.id, t.classId),
    unique().on(t.attemptId, t.number),
    index().on(t.classId, t.resourceId),
    foreignKey({
      name: 'grades_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'grades_release_fk',
      columns: [t.releaseId, t.classId],
      foreignColumns: [gradeReleases.id, gradeReleases.classId],
    }),
    check(
      'grades_released',
      sql`(${t.state} = 'released') = (${t.releaseId} is not null and ${t.releasedAt} is not null)`,
    ),
    check('grades_reason', sql`(${t.source} = 'draft') = (${t.reason} is null)`),
    check('grades_number', sql`${t.number} >= 1`),
  ],
);

export const gradeOverrides = pgTable(
  'grade_overrides',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    attemptId: uuid().notNull(),
    /** The grade row this override replaced; it is never changed. */
    priorGradeId: uuid().notNull(),
    points: doublePrecision().notNull(),
    reason: text().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'grade_overrides_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'grade_overrides_prior_fk',
      columns: [t.priorGradeId, t.classId],
      foreignColumns: [grades.id, grades.classId],
    }).onDelete('cascade'),
    check('grade_overrides_reason', sql`length(trim(${t.reason})) > 0`),
    check('grade_overrides_points', sql`${t.points} >= 0`),
  ],
);
