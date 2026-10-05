import type { RunnerLimits } from '@parallax/contracts';
import {
  executionCheckSets,
  executionReasons,
  executionStates,
} from '@parallax/contracts/routes/runs';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { resourceRevisions } from './content';
import { classes } from './memberships';
import { testAttempts } from './tests';
import { users } from './users';

/**
 * Code runs (docs/design/runner.md §8.3). One `execution_jobs` row per run request, one
 * immutable `execution_results` row per run that produced an outcome. Both are class data read
 * through a resolved class scope (ADR-0002), with one recorded exception: the per-student cap
 * counts a user's own `execution_jobs` across classes through `forOwnRows` (design §8.4).
 */

export const executionState = pgEnum('execution_state', executionStates);
export const executionReason = pgEnum('execution_reason', executionReasons);
export const executionCheckSet = pgEnum('execution_check_set', executionCheckSets);
export const executionContext = pgEnum('execution_context', ['attempt', 'preview']);
export const executionResultStatus = pgEnum('execution_result_status', [
  'passed',
  'failed',
  'time_limited',
  'resource_exhausted',
]);

/** The editable files a run was asked for, kept so a replay runs the same bytes. */
export interface RunSnapshot {
  files: { path: string; content: string }[];
}

/** Why a run is `infrastructure_error` (design §8.5); `message` at most 512 bytes. */
export interface RunFailure {
  kind: string;
  message: string;
}

export const executionJobs = pgTable(
  'execution_jobs',
  {
    /** The `jobId` the runner receives and echoes back. */
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for an instructor preview run (P3-18). */
    attemptId: uuid(),
    questionRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    questionId: text().notNull(),
    context: executionContext().notNull(),
    checkSet: executionCheckSet().notNull(),
    reason: executionReason().notNull(),
    codeHash: text().notNull(),
    snapshot: jsonb().$type<RunSnapshot>().notNull(),
    runtimeId: text().notNull(),
    imageRef: text().notNull(),
    harnessVersion: text().notNull(),
    graderVersion: text().notNull(),
    limits: jsonb().$type<RunnerLimits>().notNull(),
    /** Chosen by the server and written here before the job is sent (design §2 step 4). */
    bossJobId: uuid().notNull().unique(),
    /** Set by the conditional update once `bossExec.send` has returned. */
    jobSentAt: timestamp({ withTimezone: true }),
    state: executionState().notNull().default('queued'),
    /** The pg-boss job's `retryCount` when the outcome was recorded; null when it was gone. */
    infrastructureAttempts: integer(),
    priority: integer().notNull(),
    failure: jsonb().$type<RunFailure>(),
    /** The instructor who asked for a replay or regrade. */
    requestedBy: uuid().references(() => users.id),
    note: text(),
    supersededBy: uuid().references((): AnyPgColumn => executionJobs.id),
    queuedAt: timestamp({ withTimezone: true }).notNull(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.id, t.classId),
    foreignKey({
      name: 'execution_jobs_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    index().on(t.userId, t.state),
    index().on(t.attemptId, t.questionId, t.queuedAt),
    index().on(t.classId),
    /** One grading run per question of an attempt, so the submission hook can run again. */
    uniqueIndex('execution_jobs_grading_once')
      .on(t.attemptId, t.questionId)
      .where(sql`${t.reason} = 'grading'`),
    check('execution_jobs_context', sql`(${t.context} = 'preview') = (${t.attemptId} is null)`),
    check(
      'execution_jobs_failure',
      sql`(${t.state} = 'infrastructure_error') = (${t.failure} is not null)`,
    ),
  ],
);

export const executionResults = pgTable(
  'execution_results',
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid().notNull().unique(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attemptId: uuid(),
    questionRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    questionId: text().notNull(),
    checkSet: executionCheckSet().notNull(),
    reason: executionReason().notNull(),
    codeHash: text().notNull(),
    status: executionResultStatus().notNull(),
    imageId: text().notNull(),
    imageDigest: text(),
    harnessVersion: text().notNull(),
    graderVersion: text().notNull(),
    /** The validated `RunnerOutcome`, hidden checks included. */
    outcome: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'execution_results_job_fk',
      columns: [t.jobId, t.classId],
      foreignColumns: [executionJobs.id, executionJobs.classId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'execution_results_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [testAttempts.id, testAttempts.classId],
    }).onDelete('cascade'),
    index().on(t.attemptId, t.questionId),
    index().on(t.attemptId, t.questionId, t.codeHash, t.checkSet, t.graderVersion),
    index().on(t.classId),
  ],
);
