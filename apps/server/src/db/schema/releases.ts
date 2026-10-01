import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { resourceRevisions, resources, resourceTab, resourceVisibility, topics } from './content';
import { classes, courses } from './memberships';
import { users } from './users';

/**
 * Published, immutable snapshots of a course (ADR-0003). A trigger rejects UPDATE and DELETE
 * on this table and its two child tables; fixing a published mistake means a new release.
 */
export const courseReleases = pgTable(
  'course_releases',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid()
      .notNull()
      .references(() => courses.id),
    version: integer().notNull(),
    validationReport: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.version), unique().on(t.id, t.courseId)],
);

export const releaseTopics = pgTable(
  'release_topics',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseId: uuid()
      .notNull()
      .references(() => courseReleases.id),
    /** The draft topic this snapshot was taken from; lets adoption diff releases. */
    topicId: uuid()
      .notNull()
      .references(() => topics.id),
    position: integer().notNull(),
    title: text().notNull(),
    objective: text().notNull(),
    prerequisites: jsonb().$type<string[]>().notNull(),
    completionRule: jsonb().$type<Record<string, unknown>>(),
    estimatedMinutes: integer(),
  },
  (t) => [unique().on(t.releaseId, t.topicId), unique().on(t.id, t.releaseId)],
);

/** One pinned resource revision in a release: reads for a class always end here (A16, A26). */
export const releaseResources = pgTable(
  'release_resources',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseId: uuid().notNull(),
    releaseTopicId: uuid().notNull(),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    tab: resourceTab().notNull(),
    position: integer().notNull(),
    title: text().notNull(),
    visibility: resourceVisibility().notNull(),
    releaseAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'release_resources_topic_fk',
      columns: [t.releaseTopicId, t.releaseId],
      foreignColumns: [releaseTopics.id, releaseTopics.releaseId],
    }),
    unique().on(t.releaseId, t.resourceId),
    index().on(t.resourceRevisionId),
  ],
);

/** Every adoption of a release by a class: actor, from, to and the diff summary shown. */
export const classReleaseHistory = pgTable(
  'class_release_history',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    fromReleaseId: uuid().references(() => courseReleases.id),
    toReleaseId: uuid()
      .notNull()
      .references(() => courseReleases.id),
    actorId: uuid().references(() => users.id),
    diff: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.classId, t.createdAt)],
);
