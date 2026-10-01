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
 * Practice attempts on exercises (§9, §13). An attempt is pinned to the revision it started
 * on and carries the seed of its random draws, so review replays what the student saw.
 * Starting again supersedes the attempt and opens a new one; nothing is erased.
 */
export const exerciseHelp = pgEnum('exercise_help', [
  'independent',
  'with_hints',
  'solution_shown',
]);
export const exerciseEventKind = pgEnum('exercise_event_kind', [
  'check',
  'hint_shown',
  'solution_revealed',
  'step_completed',
  'restart',
]);

export const exerciseAttempts = pgTable(
  'exercise_attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Written by a preview principal; review excludes it. */
    isPreview: boolean().notNull().default(false),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    /** 1 for the first attempt, then one more per Start again. */
    number: integer().notNull(),
    seed: integer().notNull(),
    /** Set when the last step completes: the most help any step needed. */
    completion: exerciseHelp(),
    completedAt: timestamp({ withTimezone: true }),
    /** Set by Start again; a superseded attempt accepts no further events. */
    supersededAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.id, t.classId),
    unique().on(t.classId, t.userId, t.resourceId, t.number),
    uniqueIndex('exercise_attempts_current')
      .on(t.classId, t.userId, t.resourceId)
      .where(sql`${t.supersededAt} is null`),
    index().on(t.classId, t.resourceId),
    check(
      'exercise_attempts_completion',
      sql`(${t.completion} is null) = (${t.completedAt} is null)`,
    ),
  ],
);

/**
 * What happened in an attempt, append-only (a trigger rejects updates and direct deletes):
 * hint and solution use stays recorded whatever the page currently shows (A23).
 */
export const exerciseEvents = pgTable(
  'exercise_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    attemptId: uuid().notNull(),
    /** Null for `restart`, which concerns the whole attempt. */
    stepId: text(),
    kind: exerciseEventKind().notNull(),
    /** check: `{ response, correct, feedback }`; hint_shown: `{ index }`; step_completed: `{ help, response? }`. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Orders events of one attempt even within one timestamp. */
    seq: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'exercise_events_attempt_fk',
      columns: [t.attemptId, t.classId],
      foreignColumns: [exerciseAttempts.id, exerciseAttempts.classId],
    }).onDelete('cascade'),
    unique().on(t.attemptId, t.seq),
    check('exercise_events_step', sql`(${t.kind} = 'restart') = (${t.stepId} is null)`),
  ],
);
