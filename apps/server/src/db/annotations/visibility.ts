import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ClassScope } from '../../auth/scope';
import { forClass } from '../scoped';

// The SQL form of the audience rule in `annotations/visibility.ts` (ADR-0002, §8, §13).

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
