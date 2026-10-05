import { boolean, index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { resources, topics } from './content';
import { classes } from './memberships';
import { users } from './users';

/**
 * A student's own mark that one piece of ungraded material is reviewed (§4). One row per
 * student, class and resource; unmarking deletes it. The mark is a statement by the student,
 * never a grade: reading or viewing never creates one, and graded requirements come from
 * submissions instead. `topic_id` is the stable draft topic, so a mark survives a release
 * change that keeps the resource.
 */
export const topicReviews = pgTable(
  'topic_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Written by a preview principal; review and counts exclude it. */
    isPreview: boolean().notNull().default(false),
    topicId: uuid()
      .notNull()
      .references(() => topics.id),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.classId, t.userId, t.resourceId), index().on(t.classId, t.userId)],
);
