import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * True when the course has an owner other than `userId` whose account is not deactivated: the one
 * definition of "another active owner" behind both `owns_courses` (account closure) and
 * `last_owner` (withdrawing ownership), so the two cannot disagree (§3: a course without an owner
 * could be neither managed nor restored). `courseId` is a column of the enclosing query or an id.
 */
export const otherActiveOwnerExists = (courseId: AnyPgColumn | string, userId: string): SQL =>
  sql`exists (select 1 from course_memberships o join users u on u.id = o.user_id
    where o.course_id = ${courseId} and o.owner and o.user_id <> ${userId}
      and u.deactivated_at is null)`;
