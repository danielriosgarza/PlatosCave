import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ClassScope } from '../auth/scope';
import { forClass } from '../db/scoped';

/**
 * The one audience rule for annotations, threads and posts (ADR-0002, §8, §13). Every read,
 * count, notification and export of these rows filters through this module:
 *
 * - `private` → the author only; instructors never see personal study marks (§17 default);
 * - `instructor` → the author and the class's instructors;
 * - `class` → every member of the class.
 *
 * Rows always belong to one class, so another cohort of the same course never sees them
 * (A21). Rows written by a preview principal are seen by that principal only, so "Preview as
 * student" never posts into a real class discussion.
 */

export type Audience = 'private' | 'instructor' | 'class';

export interface Viewer {
  userId: string;
  role: 'student' | 'instructor';
}

export interface Audienced {
  authorId: string;
  audience: Audience;
  isPreview?: boolean;
}

export const viewerOf = (scope: ClassScope): Viewer => ({
  userId: scope.user.id,
  role: scope.role,
});

/** Whether `viewer`, a member of the row's class, may read the row. */
export function canSee(viewer: Viewer, row: Audienced): boolean {
  if (row.authorId === viewer.userId) return true;
  if (row.isPreview) return false;
  if (row.audience === 'class') return true;
  return row.audience === 'instructor' && viewer.role === 'instructor';
}

interface AudiencedTable {
  classId: PgColumn;
  authorId: PgColumn;
  audience: PgColumn;
  isPreview?: PgColumn;
}

/** SQL form of `canSee`, including the `class_id` predicate of the caller's scope. */
export function visibleTo(scope: ClassScope, table: AudiencedTable): SQL {
  const shared = or(
    eq(table.audience, 'class'),
    scope.role === 'instructor' ? eq(table.audience, 'instructor') : sql`false`,
  );
  const notPreview = table.isPreview ? eq(table.isPreview, false) : sql`true`;
  return and(
    forClass(scope, table),
    or(eq(table.authorId, scope.user.id), and(notPreview, shared)),
  ) as SQL;
}

/** Posts inside a visible thread: hides other people's preview posts, keeps everything else. */
export function visiblePost(
  scope: ClassScope,
  table: { classId: PgColumn; authorId: PgColumn; isPreview: PgColumn },
): SQL {
  return and(
    forClass(scope, table),
    or(eq(table.authorId, scope.user.id), eq(table.isPreview, false)),
  ) as SQL;
}
