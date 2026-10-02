import type { Anchor } from '@parallax/contracts';
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
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { resourceRevisions, resources } from './content';
import { classes } from './memberships';
import { users } from './users';

/**
 * Annotations and discussions (§8, §13). Every row is class-scoped: two cohorts of one course
 * never share a note or a thread (A21). Who may read a row is decided only by
 * `annotations/visibility.ts` and its SQL form in `db/annotations/visibility.ts` (ADR-0002):
 * private → author; instructor → author and the class's instructors; class → class members.
 */
export const audience = pgEnum('audience', ['private', 'instructor', 'class']);
export const annotationKind = pgEnum('annotation_kind', ['highlight', 'note', 'sketch']);
export const threadStatus = pgEnum('thread_status', ['open', 'resolved']);
export const placementStatus = pgEnum('placement_status', [
  'mapped',
  'needs_reattachment',
  'manual',
]);

/**
 * Private study marks. Sharing never changes a row's audience: it is an explicit action that
 * copies the anchor and quoted context into a new thread (§8).
 */
export const annotations = pgTable(
  'annotations',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The draft resource id, stable across revisions; lists are keyed by it. */
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    /** The revision the anchor was made against (ADR-0003); placements map it to later ones. */
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    kind: annotationKind().notNull(),
    audience: audience().notNull().default('private'),
    anchor: jsonb().$type<Anchor>().notNull(),
    body: text(),
    color: text(),
    /** Optimistic counter for autosave: every update checks and increments it. */
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.classId, t.resourceId, t.authorId),
    unique().on(t.id, t.classId),
    check('annotations_private', sql`${t.audience} = 'private'`),
  ],
);

/** A discussion opened by Ask or by sharing a note; its first post is the question. */
export const threads = pgTable(
  'threads',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    /**
     * Plain reference, like `createdBy` elsewhere: deleting an account must not take other
     * members' replies with it; identity removal anonymises instead (plan §8 #23).
     */
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    /** Written by a preview principal: visible to that principal only, never to the class. */
    isPreview: boolean().notNull().default(false),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    anchor: jsonb().$type<Anchor>().notNull(),
    audience: audience().notNull(),
    status: threadStatus().notNull().default('open'),
    resolvedAt: timestamp({ withTimezone: true }),
    resolvedBy: uuid().references(() => users.id),
    /** The private note this thread was shared from; the note itself stays private. */
    sourceAnnotationId: uuid().references(() => annotations.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.classId, t.resourceId),
    index().on(t.classId, t.createdAt),
    unique().on(t.id, t.classId),
    check('threads_shared', sql`${t.audience} in ('instructor', 'class')`),
  ],
);

/**
 * Posts of a thread. Deleting a post that replies depend on keeps a tombstone (`deletedAt`
 * set, body cleared); moderation is recorded here and in `audit_events` (§8).
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid().primaryKey().defaultRandom(),
    threadId: uuid().notNull(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    isPreview: boolean().notNull().default(false),
    /** The post this one replies to, always in the same thread (composite FK below). */
    parentId: uuid(),
    body: text(),
    revision: integer().notNull().default(1),
    editedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    deletedBy: uuid().references(() => users.id),
    moderatedAt: timestamp({ withTimezone: true }),
    moderatedBy: uuid().references(() => users.id),
    moderationReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A post always belongs to a thread of the same class.
    foreignKey({
      name: 'posts_thread_fk',
      columns: [t.threadId, t.classId],
      foreignColumns: [threads.id, threads.classId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'posts_parent_fk',
      columns: [t.parentId, t.threadId],
      foreignColumns: [t.id, t.threadId],
    }),
    unique().on(t.id, t.threadId),
    index().on(t.threadId, t.createdAt),
    check('posts_body_or_tombstone', sql`${t.body} is not null or ${t.deletedAt} is not null`),
  ],
);

/**
 * Where an annotation or thread sits in each revision a class uses (ADR-0003). Written by the
 * mapping job and by instructors' manual placements (P2-05).
 */
export const annotationPlacements = pgTable(
  'annotation_placements',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    annotationId: uuid(),
    threadId: uuid(),
    resourceRevisionId: uuid()
      .notNull()
      .references(() => resourceRevisions.id),
    /** Null when the mark needs reattachment: the original anchor keeps quote and context. */
    anchor: jsonb().$type<Anchor>(),
    status: placementStatus().notNull(),
    confidence: real(),
    placedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'annotation_placements_annotation_fk',
      columns: [t.annotationId, t.classId],
      foreignColumns: [annotations.id, annotations.classId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'annotation_placements_thread_fk',
      columns: [t.threadId, t.classId],
      foreignColumns: [threads.id, threads.classId],
    }).onDelete('cascade'),
    unique().on(t.annotationId, t.resourceRevisionId),
    unique().on(t.threadId, t.resourceRevisionId),
    index().on(t.classId, t.resourceRevisionId),
    check('annotation_placements_target', sql`num_nonnulls(${t.annotationId}, ${t.threadId}) = 1`),
    check(
      'annotation_placements_anchor',
      sql`(${t.status} = 'needs_reattachment') = (${t.anchor} is null)`,
    ),
  ],
);
