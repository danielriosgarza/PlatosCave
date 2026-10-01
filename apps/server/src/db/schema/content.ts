import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { classes, courses } from './memberships';
import { users } from './users';

export const resourceType = pgEnum('resource_type', [
  'slides_pdf',
  'slides_web',
  'reading_native',
  'reading_pdf',
  'exercise',
  'notebook',
  'shiny',
  'test',
]);
export const resourceTab = pgEnum('resource_tab', [
  'slides',
  'reading',
  'exercises',
  'notebooks',
  'tests',
]);
export const resourceVisibility = pgEnum('resource_visibility', ['visible', 'hidden']);

/**
 * Draft topics of a course (ADR-0003). Mutable; `revision` is the optimistic-concurrency
 * counter that every mutation checks and increments (§12: never overwrite silently).
 */
export const topics = pgTable(
  'topics',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    objective: text().notNull().default(''),
    prerequisites: jsonb().$type<string[]>().notNull().default([]),
    completionRule: jsonb().$type<Record<string, unknown>>(),
    estimatedMinutes: integer(),
    revision: integer().notNull().default(1),
    archivedAt: timestamp({ withTimezone: true }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.courseId, t.position), unique().on(t.id, t.courseId)],
);

/** Draft resources; `headRevisionId` names the newest immutable revision, if any. */
export const resources = pgTable(
  'resources',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid().notNull(),
    topicId: uuid().notNull(),
    type: resourceType().notNull(),
    title: text().notNull(),
    position: integer().notNull(),
    visibility: resourceVisibility().notNull().default('visible'),
    releaseAt: timestamp({ withTimezone: true }),
    headRevisionId: uuid().references((): AnyPgColumn => resourceRevisions.id),
    revision: integer().notNull().default(1),
    archivedAt: timestamp({ withTimezone: true }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A resource and its topic always belong to the same course.
    foreignKey({
      name: 'resources_topic_fk',
      columns: [t.topicId, t.courseId],
      foreignColumns: [topics.id, topics.courseId],
    }),
    index().on(t.topicId, t.position),
    index().on(t.courseId),
    unique().on(t.id, t.courseId),
  ],
);

/**
 * Immutable content of one resource version (ADR-0003). A trigger rejects updates to any
 * column except `derived` (conversion outputs); foreign keys keep referenced rows alive.
 */
export const resourceRevisions = pgTable(
  'resource_revisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    resourceId: uuid().notNull(),
    courseId: uuid().notNull(),
    type: resourceType().notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Content-addressed storage keys `courses/{courseId}/objects/{sha256}`. */
    objectKeys: text().array().notNull().default(sql`'{}'::text[]`),
    derived: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    accessibleAlternative: jsonb().$type<Record<string, unknown>>(),
    provenance: jsonb().$type<Record<string, unknown>>(),
    contentHash: text().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'resource_revisions_resource_fk',
      columns: [t.resourceId, t.courseId],
      foreignColumns: [resources.id, resources.courseId],
    }),
    index().on(t.resourceId, t.createdAt),
  ],
);

/** Last place a person studied one resource revision in one class (§13). Never a grade. */
export const studyPositions = pgTable(
  'study_positions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    tab: resourceTab().notNull(),
    position: jsonb().$type<Record<string, unknown>>().notNull(),
    layout: jsonb().$type<Record<string, unknown>>(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.classId, t.resourceRevisionId), index().on(t.classId)],
);
