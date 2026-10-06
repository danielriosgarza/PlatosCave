import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { classMemberships } from './schema';

/**
 * Whether the latest `membership.remove` audit event for `userId` in `classId` recorded the role
 * `student`: removal deletes the membership row, so this is what is left of it.
 */
export const removedAsStudent = (classId: SQL | PgColumn, userId: SQL | PgColumn): SQL =>
  sql`(select e.before ->> 'role' from audit_events e
    where e.action = 'membership.remove' and e.scope_kind = 'class'
      and e.scope_id = ${classId} and e.target_id = ${userId}
    order by e.created_at desc limit 1) = 'student'`;

/**
 * The instructor-review filter for work in a class (§3): the submitter is a student of the class,
 * or was one until removed. Removal deletes the membership row, so a row without a membership
 * qualifies only when the latest `membership.remove` audit event for that user in this class
 * recorded the role `student`; a removed instructor's own non-preview work stays out. Joins
 * `classMemberships` with a LEFT JOIN on class and user.
 */
export const studentOrRemovedStudent = (table: { classId: PgColumn; userId: PgColumn }): SQL =>
  or(
    eq(classMemberships.role, 'student'),
    and(sql`${classMemberships.role} is null`, removedAsStudent(table.classId, table.userId)),
  ) as SQL;
