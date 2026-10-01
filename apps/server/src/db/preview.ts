import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { CourseScope } from '../auth/scope';
import { createSession } from '../auth/sessions';
import type { Db } from './client';
import { insertPreviewPrincipal } from './identity';
import { authSessions, classes, classMemberships, topics, users } from './schema';
import { forCourse } from './scoped';

/** A draft preview session ends after a working session, whatever the instructor's lasts. */
export const PREVIEW_SESSION_TTL_MS = 8 * 60 * 60_000;

/**
 * The review and export exclusion hook (ADR-0002): true for rows whose `userId` is a real person,
 * false for a preview principal's. Every instructor review, count and export of student work
 * filters its rows through it, so preview attempts never reach a real class's records.
 */
export const excludePreview = (userId: PgColumn): SQL =>
  sql`not exists (select 1 from ${users} where ${users.id} = ${userId} and ${users.kind} = 'preview')`;

export type StartedPreview =
  | { ok: true; previewUserId: string; classId: string; token: string }
  | { ok: false };

/**
 * Starts "Preview as student" of the course draft in one class the caller teaches (§3, §12):
 * reuses or creates the caller's preview principal for that class (ADR-0002), ends its earlier
 * sessions, and opens a new session for it. `{ ok: false }` when the class is not one the caller
 * teaches in this course, or `topicId` is not a topic of the course draft.
 */
export async function startPreview(
  db: Db,
  scope: CourseScope,
  input: { classId: string; topicId?: string | undefined },
  now: Date,
): Promise<StartedPreview> {
  const instructorId = scope.user.id;
  if (scope.user.kind !== 'user') return { ok: false };
  const previewUserId = await db.transaction(async (tx) => {
    if (input.topicId) {
      const [topic] = await tx
        .select({ id: topics.id })
        .from(topics)
        .where(and(forCourse(scope, topics), eq(topics.id, input.topicId)));
      if (!topic) return undefined;
    }
    // Locking the teaching membership serialises two starts, so each class gets one principal.
    const [teaching] = await tx
      .select({ id: classMemberships.id })
      .from(classMemberships)
      .innerJoin(classes, eq(classes.id, classMemberships.classId))
      .where(
        and(
          forCourse(scope, classes),
          eq(classMemberships.classId, input.classId),
          eq(classMemberships.userId, instructorId),
          eq(classMemberships.role, 'instructor'),
        ),
      )
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
          eq(classMemberships.classId, input.classId),
          eq(classMemberships.isPreview, true),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.userId, existing.id), isNull(authSessions.revokedAt)));
      return existing.id;
    }
    return insertPreviewPrincipal(tx, { classId: input.classId, instructorId });
  });
  if (!previewUserId) return { ok: false };
  // The preview never claims a sign-in of its own: it carries its owner's authentication time.
  const authTime = 'authTime' in scope.user ? (scope.user.authTime as Date) : new Date(0);
  const { token } = await createSession(db, previewUserId, {
    now,
    authTime,
    ttlMs: PREVIEW_SESSION_TTL_MS,
  });
  return { ok: true, previewUserId, classId: input.classId, token };
}
