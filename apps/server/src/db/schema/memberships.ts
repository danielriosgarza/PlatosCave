import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const classRole = pgEnum('class_role', ['student', 'instructor']);
export const inviteKind = pgEnum('invite_kind', ['enrolment', 'instructor']);

export const courses = pgTable('courses', {
  id: uuid().primaryKey().defaultRandom(),
  title: text().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  /** Archived courses keep read access for their members and refuse writes (§4, §12). */
  archivedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Course grants (ADR-0002): creation grants `owner`; inviting a class instructor grants `editor`. */
export const courseMemberships = pgTable(
  'course_memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    owner: boolean().notNull().default(false),
    editor: boolean().notNull().default(false),
    publisher: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.userId), index().on(t.userId)],
);

export const classes = pgTable(
  'classes',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid()
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * Adopted course release (ADR-0003). Migration 0002 adds the foreign key
     * `(release_id, course_id) → course_releases (id, course_id)` in SQL, because declaring it
     * here would make this module and releases.ts import each other.
     */
    releaseId: uuid(),
    archivedAt: timestamp({ withTimezone: true }),
    /** Declared discussion policy (§8): whether students may edit or delete their own posts. */
    studentsEditPosts: boolean().notNull().default(true),
    studentsDeletePosts: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.courseId)],
);

export const classMemberships = pgTable(
  'class_memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: classRole().notNull(),
    manageMembers: boolean().notNull().default(false),
    isPreview: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.classId, t.userId),
    index().on(t.userId),
    check(
      'class_memberships_preview_student',
      sql`not ${t.isPreview} or (${t.role} = 'student' and not ${t.manageMembers})`,
    ),
  ],
);

/**
 * Enrolment codes (create `student` rows only) and instructor invitations (addressed to one
 * email). Only the SHA-256 of the code is stored; the code is shown once when issued.
 */
export const classInvites = pgTable(
  'class_invites',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    kind: inviteKind().notNull(),
    codeHash: text().notNull().unique(),
    email: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp({ withTimezone: true }),
    /** Capacity; null means unlimited. */
    maxUses: integer(),
    useCount: integer().notNull().default(0),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.classId),
    check('class_invites_instructor_email', sql`${t.kind} = 'enrolment' or ${t.email} is not null`),
    check('class_invites_capacity', sql`${t.maxUses} is null or ${t.useCount} <= ${t.maxUses}`),
  ],
);
