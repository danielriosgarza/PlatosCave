import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { CourseScope } from '../auth/scope';
import { audit } from './audit';
import { createSession } from './auth/sessions';
import type { Db } from './client';
import { insertPreviewPrincipal } from './identity';
import { authSessions, classes, classMemberships, topics, users } from './schema';
import { forCourse } from './scoped';

/** A draft preview session ends after a working session, whatever the instructor's lasts. */
export const PREVIEW_SESSION_TTL_MS = 8 * 60 * 60_000;

/**
 * The review and export exclusion hook (ADR-0002): true for rows a real person wrote, false for
 * a preview principal's. Every instructor review, count and export of student work filters its
 * rows through it, so preview attempts never reach a real class's records. The one source of
 * truth is the `is_preview` flag every writer stamps from the caller's membership (attempts,
 * annotations, threads, posts, memberships), the same flag `db/annotations/visibility.ts` reads.
 */
export const excludePreview = (table: { isPreview: PgColumn }): SQL => eq(table.isPreview, false);

export type StartedPreview =
  | { ok: true; previewUserId: string; name: string; classId: string; token: string }
  | { ok: false };

/**
 * Starts "Preview as student" of the course draft in one class the caller teaches (§3, §12):
 * reuses or creates the caller's preview principal for that class (ADR-0002), ends its earlier
 * sessions, and opens a new session for it, all in one transaction. `{ ok: false }` when the
 * class is not one the caller teaches in this course or is archived, or `topicId` is not a live
 * topic of the course draft. The preview never claims a sign-in of its own: its session carries
 * `authTime`, its owner's authentication time.
 */
export async function startPreview(
  db: Db,
  scope: CourseScope,
  input: { classId: string; topicId?: string | undefined; authTime: Date },
  now: Date,
): Promise<StartedPreview> {
  const instructorId = scope.user.id;
  if (scope.user.kind !== 'user') return { ok: false };
  const started = await db.transaction(async (tx) => {
    if (input.topicId) {
      const [topic] = await tx
        .select({ id: topics.id })
        .from(topics)
        .where(
          and(forCourse(scope, topics), eq(topics.id, input.topicId), isNull(topics.archivedAt)),
        );
      if (!topic) return undefined;
    }
    // Locking the teaching membership serialises two starts, so each class gets one principal
    // and one live preview session.
    const [teaching] = await tx
      .select({ id: classMemberships.id })
      .from(classMemberships)
      .innerJoin(classes, eq(classes.id, classMemberships.classId))
      .where(
        and(
          forCourse(scope, classes),
          isNull(classes.archivedAt),
          eq(classMemberships.classId, input.classId),
          eq(classMemberships.userId, instructorId),
          eq(classMemberships.role, 'instructor'),
        ),
      )
      .for('update', { of: classMemberships });
    if (!teaching) return undefined;
    const [existing] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(classMemberships, eq(classMemberships.userId, users.id))
      .where(
        and(
          eq(users.kind, 'preview'),
          eq(users.ownerUserId, instructorId),
          eq(classMemberships.classId, input.classId),
          eq(classMemberships.isPreview, true),
        ),
      )
      .limit(1);
    let principal = existing;
    if (existing) {
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.userId, existing.id), isNull(authSessions.revokedAt)));
    } else {
      principal = await insertPreviewPrincipal(tx, { classId: input.classId, instructorId });
    }
    if (!principal) throw new Error('preview principal missing');
    const { token } = await createSession(tx, principal.id, {
      now,
      authTime: input.authTime,
      ttlMs: PREVIEW_SESSION_TTL_MS,
    });
    await audit(tx, {
      actorId: instructorId,
      action: 'preview.start',
      scopeKind: 'class',
      scopeId: input.classId,
      targetType: 'user',
      targetId: principal.id,
      after: input.topicId ? { topicId: input.topicId } : null,
    });
    return { previewUserId: principal.id, name: principal.name, token };
  });
  if (!started) return { ok: false };
  return { ok: true, classId: input.classId, ...started };
}

/**
 * Audits the end of a preview session by its owner (ADR-0002). Nothing is written when the
 * preview principal has no preview membership, so a replayed exit appends nothing for a
 * principal that was never previewing.
 */
export async function recordPreviewExit(
  db: Db,
  input: { previewUserId: string; instructorId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ classId: classMemberships.classId })
      .from(classMemberships)
      .where(
        and(eq(classMemberships.userId, input.previewUserId), eq(classMemberships.isPreview, true)),
      )
      .limit(1);
    if (!membership) return;
    await audit(tx, {
      actorId: input.instructorId,
      action: 'preview.exit',
      scopeKind: 'class',
      scopeId: membership.classId,
      targetType: 'user',
      targetId: input.previewUserId,
    });
  });
}

/**
 * The class a preview run happens in, and the preview principal that owns the run (design §8.3:
 * preview runs have `attempt_id NULL` and the preview principal as `user_id`): the oldest live
 * class of the course the caller teaches. `create` makes the principal on first use; without it
 * a caller who never previewed finds nothing. Locking the teaching membership serialises two
 * first uses with each other and with `startPreview`, so a class has one principal.
 */
export async function previewRunClass(
  db: Db,
  scope: CourseScope,
  opts: { create: boolean },
): Promise<{ classId: string; previewUserId: string } | undefined> {
  if (scope.user.kind !== 'user') return undefined;
  const instructorId = scope.user.id;
  return db.transaction(async (tx) => {
    const [teaching] = await tx
      .select({ id: classMemberships.id, classId: classMemberships.classId })
      .from(classMemberships)
      .innerJoin(classes, eq(classes.id, classMemberships.classId))
      .where(
        and(
          forCourse(scope, classes),
          isNull(classes.archivedAt),
          eq(classMemberships.userId, instructorId),
          eq(classMemberships.role, 'instructor'),
        ),
      )
      .orderBy(asc(classes.createdAt), asc(classes.id))
      .limit(1)
      .for('update', { of: classMemberships });
    if (!teaching) return undefined;
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(classMemberships, eq(classMemberships.userId, users.id))
      .where(
        and(
          eq(users.kind, 'preview'),
          eq(users.ownerUserId, instructorId),
          eq(classMemberships.classId, teaching.classId),
          eq(classMemberships.isPreview, true),
        ),
      )
      .limit(1);
    if (existing) return { classId: teaching.classId, previewUserId: existing.id };
    if (!opts.create) return undefined;
    const principal = await insertPreviewPrincipal(tx, {
      classId: teaching.classId,
      instructorId,
    });
    return { classId: teaching.classId, previewUserId: principal.id };
  });
}
