import { bigint, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { courses } from './memberships';
import { users } from './users';

/** Objects a course holds in the `Storage` backend, keyed by content (ADR-0003). */
export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid().primaryKey().defaultRandom(),
    courseId: uuid()
      .notNull()
      .references(() => courses.id),
    key: text().notNull().unique(),
    sha256: text().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    contentType: text().notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.sha256), index().on(t.courseId)],
);
