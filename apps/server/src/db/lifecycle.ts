import { strokesToSvg } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/lifecycle';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassManagerScope, ClassScope, CourseScope, UserScope } from '../auth/scope';
import { audit } from './audit';
import type { Db, Tx } from './client';
import {
  annotations,
  auditEvents,
  authSessions,
  classes,
  classInvites,
  connectorPairings,
  courseMemberships,
  courses,
  posts,
  resources,
  signinTokens,
  threads,
  topics,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * The data lifecycle (§4, §8, §12, §13): archive and restore, a person's own export, and closing
 * an account. Archiving only sets a timestamp; what an archived class or course refuses is
 * decided once, in `registerRoute`, from the resolved scope.
 */

type Exported = z.input<typeof contracts.exportAnnotations.response>;

/** What an archive or restore call leaves behind, or why it changed nothing. */
export type ArchiveOutcome =
  | { ok: true; id: string; archived: boolean }
  | { ok: false; reason: 'not_archived' | 'course_archived' | 'already_archived' };

/** Archives the scope's class. Nothing changes, and nothing is audited, if it already is. */
export function archiveClass(db: Db, scope: ClassManagerScope, now: Date): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(classes)
      .set({ archivedAt: now })
      .where(and(eq(classes.id, scope.classId), isNull(classes.archivedAt)))
      .returning({ id: classes.id });
    if (!row) return { ok: false, reason: 'already_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.archive',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      before: { archived: false },
      after: { archived: true, via: scope.via },
    });
    return { ok: true, id: row.id, archived: true };
  });
}

/** Restores the scope's class, unless its course is archived too: that is restored first. */
export function restoreClass(db: Db, scope: ClassManagerScope, now: Date): Promise<ArchiveOutcome> {
  if (scope.courseArchived) return Promise.resolve({ ok: false, reason: 'course_archived' });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(classes)
      .set({ archivedAt: null })
      .where(and(eq(classes.id, scope.classId), sql`${classes.archivedAt} is not null`))
      .returning({ id: classes.id });
    if (!row) return { ok: false, reason: 'not_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.restore',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      before: { archived: true },
      after: { archived: false, via: scope.via, at: now.toISOString() },
    });
    return { ok: true, id: row.id, archived: false };
  });
}

export function archiveCourse(db: Db, scope: CourseScope, now: Date): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(courses)
      .set({ archivedAt: now })
      .where(and(eq(courses.id, scope.courseId), isNull(courses.archivedAt)))
      .returning({ id: courses.id });
    if (!row) return { ok: false, reason: 'already_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'course.archive',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'course',
      targetId: scope.courseId,
      before: { archived: false },
      after: { archived: true },
    });
    return { ok: true, id: row.id, archived: true };
  });
}

export function restoreCourse(db: Db, scope: CourseScope): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(courses)
      .set({ archivedAt: null })
      .where(and(eq(courses.id, scope.courseId), sql`${courses.archivedAt} is not null`))
      .returning({ id: courses.id });
    if (!row) return { ok: false, reason: 'not_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'course.restore',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'course',
      targetId: scope.courseId,
      before: { archived: true },
      after: { archived: false },
    });
    return { ok: true, id: row.id, archived: false };
  });
}

/** The default proportions of a figure and of a page, as the reading's own sketch export uses. */
const FIGURE_ASPECT = 0.6;
const PAGE_ASPECT = 1.414;

type AnchorOf = Exported['annotations'][number]['source']['anchor'];

/** A mark's place in words, and the passage it quotes, if any (§8). */
function describeAnchor(anchor: AnchorOf): { reference: string; quote: string | null } {
  switch (anchor.kind) {
    case 'text':
      return { reference: 'passage', quote: anchor.quote };
    case 'pdf':
      return { reference: `page ${anchor.page + 1}`, quote: anchor.quote ?? null };
    case 'slide':
      return { reference: `slide ${anchor.page + 1}`, quote: null };
    case 'figure':
      return { reference: `figure ${anchor.figureId}`, quote: null };
    case 'none':
      return { reference: 'whole resource', quote: null };
  }
}

/** A sketch's strokes as a standalone SVG, with its description as the accessible text. */
function drawingOf(
  anchor: AnchorOf,
  title: string,
  description: string | null,
): { svg: string; description: string | null } | null {
  if (anchor.kind !== 'figure' && anchor.kind !== 'pdf') return null;
  if (!anchor.strokes) return null;
  const svg = strokesToSvg(anchor.strokes, {
    aspect: anchor.kind === 'pdf' ? PAGE_ASPECT : FIGURE_ASPECT,
    title: `Sketch · ${title}`,
    description: description ?? '',
  });
  return { svg, description };
}

/**
 * The caller's own annotations in the scope's class, and their own posts (§8 "private annotation
 * export includes text, resource title, source reference, and readable drawings"). Only rows the
 * caller authored are read, and only this class's; the export is audited (§13).
 */
export function exportOwnAnnotations(db: Db, scope: ClassScope, now: Date): Promise<Exported> {
  return db.transaction(async (tx) => {
    const marks = await tx
      .select({
        annotation: annotations,
        resourceTitle: resources.title,
        topicTitle: topics.title,
      })
      .from(annotations)
      .innerJoin(resources, eq(resources.id, annotations.resourceId))
      .innerJoin(topics, eq(topics.id, resources.topicId))
      .where(and(forClass(scope, annotations), eq(annotations.authorId, scope.user.id)))
      .orderBy(asc(annotations.createdAt), asc(annotations.id));
    const written = await tx
      .select({
        id: posts.id,
        threadId: posts.threadId,
        body: posts.body,
        deletedAt: posts.deletedAt,
        createdAt: posts.createdAt,
        audience: threads.audience,
        resourceTitle: resources.title,
      })
      .from(posts)
      .innerJoin(threads, and(eq(threads.id, posts.threadId), eq(threads.classId, posts.classId)))
      .innerJoin(resources, eq(resources.id, threads.resourceId))
      .where(and(forClass(scope, posts), eq(posts.authorId, scope.user.id)))
      .orderBy(asc(posts.createdAt), asc(posts.id));
    const [info] = await tx
      .select({ name: classes.name, courseId: courses.id, courseTitle: courses.title })
      .from(classes)
      .innerJoin(courses, eq(courses.id, classes.courseId))
      .where(eq(classes.id, scope.classId));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'export.annotations',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'user',
      targetId: scope.user.id,
      after: { annotations: marks.length, posts: written.length },
    });
    return {
      exportedAt: now.toISOString(),
      class: { id: scope.classId, name: info?.name ?? scope.className },
      course: { id: scope.courseId, title: info?.courseTitle ?? scope.courseTitle },
      annotations: marks.map(({ annotation: a, resourceTitle, topicTitle }) => {
        const { reference, quote } = describeAnchor(a.anchor);
        return {
          id: a.id,
          kind: a.kind,
          body: a.body,
          resourceTitle,
          topicTitle,
          source: {
            resourceId: a.resourceId,
            resourceRevisionId: a.resourceRevisionId,
            anchor: a.anchor,
            reference,
            quote,
          },
          drawing: a.kind === 'sketch' ? drawingOf(a.anchor, resourceTitle, a.body) : null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        };
      }),
      posts: written.map((p) => ({
        id: p.id,
        threadId: p.threadId,
        audience: p.audience === 'class' ? ('class' as const) : ('instructor' as const),
        resourceTitle: p.resourceTitle,
        body: p.deletedAt ? null : p.body,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  });
}

export const ANONYMISED_NAME = 'Former user';
export const anonymisedEmail = (userId: string) => `deleted-${userId}@anonymised.invalid`;

/**
 * Replaces one identity with a pseudonym and deletes what was only theirs (plan decision 23):
 * the name and address, private annotations (their placements go with them), unused sign-in
 * links and unused instructor invitations addressed to the old address. Memberships, grades,
 * submissions, posts and audit rows stay and now carry the pseudonym. The caller records why.
 */
export async function anonymiseIdentity(tx: Tx, userId: string, now: Date): Promise<void> {
  const [row] = await tx
    .select({ email: users.email, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!row) return;
  const previews = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.ownerUserId, userId));
  const everyone = [userId, ...previews.map((p) => p.id)];
  await tx.delete(annotations).where(inArray(annotations.authorId, everyone));
  if (row.email) {
    await tx.delete(signinTokens).where(eq(signinTokens.email, row.email));
    await tx
      .delete(classInvites)
      .where(
        and(
          eq(classInvites.email, row.email),
          eq(classInvites.kind, 'instructor'),
          eq(classInvites.useCount, 0),
        ),
      );
  }
  await tx
    .update(users)
    .set({
      name: ANONYMISED_NAME,
      anonymisedAt: now,
      ...(row.kind === 'user' && { email: anonymisedEmail(userId) }),
    })
    .where(inArray(users.id, everyone));
}

export type CloseOutcome =
  | { ok: true; deactivatedAt: Date; userIds: string[] }
  | { ok: false; reason: 'owns_courses' };

/**
 * Closes the caller's own account (§13): refused while they own a live course; otherwise the
 * account and its preview principal are deactivated, every session ends, and with `delete` the
 * identity is anonymised in the same transaction. The caller then revokes the person's connectors
 * (`revokeUserConnectors`), which closes their live links.
 */
export function closeAccount(
  db: Db,
  scope: UserScope,
  mode: 'deactivate' | 'delete',
  now: Date,
): Promise<CloseOutcome> {
  const userId = scope.user.id;
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const owned = await tx
      .select({ courseId: courseMemberships.courseId })
      .from(courseMemberships)
      .innerJoin(courses, eq(courses.id, courseMemberships.courseId))
      .where(
        and(
          eq(courseMemberships.userId, userId),
          eq(courseMemberships.owner, true),
          isNull(courses.archivedAt),
        ),
      )
      .limit(1);
    if (owned.length > 0) return { ok: false, reason: 'owns_courses' };
    const previews = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.ownerUserId, userId));
    const userIds = [userId, ...previews.map((p) => p.id)];
    await tx
      .update(users)
      .set({ deactivatedAt: now })
      .where(and(inArray(users.id, userIds), isNull(users.deactivatedAt)));
    await tx
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(inArray(authSessions.userId, userIds), isNull(authSessions.revokedAt)));
    // A pairing code issued before the account closed could otherwise still start a pairing.
    await tx.delete(connectorPairings).where(inArray(connectorPairings.ownerUserId, userIds));
    await audit(tx, {
      actorId: userId,
      action: mode === 'delete' ? 'account.delete' : 'account.deactivate',
      scopeKind: 'user',
      scopeId: userId,
      targetType: 'user',
      targetId: userId,
      after: { deactivated: true, anonymised: mode === 'delete' },
    });
    if (mode === 'delete') await anonymiseIdentity(tx, userId, now);
    return { ok: true, deactivatedAt: now, userIds };
  });
}

/** What the retention job applied in one run. */
export interface RetentionResult {
  anonymised: number;
  auditEventsDeleted: number;
}

/**
 * Applies the retention policy (§13) as a system action: accounts deactivated for longer than
 * the grace period are anonymised, and audit events older than their retention period are
 * deleted. A rule whose period is null is off, so the default policy removes nothing.
 */
export async function applyRetention(
  db: Db,
  policy: { deactivatedGraceDays: number | null; auditEventDays: number | null },
  now: Date,
): Promise<RetentionResult> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  let anonymised = 0;
  if (policy.deactivatedGraceDays !== null) {
    const due = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.kind, 'user'),
          isNull(users.anonymisedAt),
          lt(users.deactivatedAt, daysAgo(policy.deactivatedGraceDays)),
        ),
      );
    for (const { id } of due) {
      await db.transaction(async (tx) => {
        await anonymiseIdentity(tx, id, now);
        await audit(tx, {
          actorId: null,
          action: 'account.anonymise',
          scopeKind: 'system',
          targetType: 'user',
          targetId: id,
          after: { reason: 'retention', graceDays: policy.deactivatedGraceDays },
        });
      });
      anonymised += 1;
    }
  }
  let auditEventsDeleted = 0;
  if (policy.auditEventDays !== null) {
    const gone = await db
      .delete(auditEvents)
      .where(lt(auditEvents.createdAt, daysAgo(policy.auditEventDays)))
      .returning({ id: auditEvents.id });
    auditEventsDeleted = gone.length;
  }
  return { anonymised, auditEventsDeleted };
}
