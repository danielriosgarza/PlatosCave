import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { ClassManagerScope, CourseContext, CourseScope } from '../auth/scope';
import { audit } from './audit';
import type { Db, Tx } from './client';
import { openInvite, type RevokeReason, revokeInvites } from './invites';
import {
  authSessions,
  classes,
  classInvites,
  classMemberships,
  courseMemberships,
  users,
} from './schema';
import { forClass, forCourse } from './scoped';

/**
 * Real members of the class (preview principals excluded) and its open invitations: not
 * revoked, not expired and not used up.
 */
export async function listMembers(db: Db, scope: ClassManagerScope, now: Date) {
  const membersQuery = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: classMemberships.role,
      manageMembers: classMemberships.manageMembers,
    })
    .from(classMemberships)
    .innerJoin(users, eq(users.id, classMemberships.userId))
    .where(and(forClass(scope, classMemberships), eq(classMemberships.isPreview, false)))
    .orderBy(asc(classMemberships.role), asc(users.name));
  const invitesQuery = db
    .select({
      id: classInvites.id,
      kind: classInvites.kind,
      email: classInvites.email,
      expiresAt: classInvites.expiresAt,
      maxUses: classInvites.maxUses,
      useCount: classInvites.useCount,
      createdAt: classInvites.createdAt,
    })
    .from(classInvites)
    .where(and(forClass(scope, classInvites), openInvite(now)))
    .orderBy(asc(classInvites.createdAt));
  const [members, invites] = await Promise.all([membersQuery, invitesQuery]);
  return { members, invites };
}

/** The real (non-preview) membership of `userId` in the scope's class. */
const realMember = (scope: ClassManagerScope, userId: string) =>
  and(
    forClass(scope, classMemberships),
    eq(classMemberships.userId, userId),
    eq(classMemberships.isPreview, false),
  );

export function setManageMembers(
  db: Db,
  scope: ClassManagerScope,
  userId: string,
  granted: boolean,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ role: classMemberships.role, manageMembers: classMemberships.manageMembers })
      .from(classMemberships)
      .where(realMember(scope, userId))
      .for('update');
    if (!member) return { ok: false as const, reason: 'not_found' as const };
    if (member.role !== 'instructor')
      return { ok: false as const, reason: 'not_instructor' as const };
    // Nothing changes, so nothing is recorded (audit_events holds changes only).
    if (member.manageMembers === granted) return { ok: true as const };
    await tx
      .update(classMemberships)
      .set({ manageMembers: granted })
      .where(realMember(scope, userId));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grant.manage_members',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'user',
      targetId: userId,
      before: { manageMembers: member.manageMembers },
      after: { manageMembers: granted, via: scope.via },
    });
    if (!granted) {
      const course = await lockCourseMembership(tx, scope, userId);
      if (!course?.owner)
        await revokeIssuedBy(tx, scope, userId, now, 'issuer_lost_manage_members');
    }
    return { ok: true as const };
  });
}

/**
 * Removes one membership. An instructor's preview membership in the class goes with them (its
 * sessions revoked), the draft editing their invitation granted ends once they teach no class of
 * the course, and the open instructor invitations they issued in the class are revoked unless
 * they own the course. Each cascade is audited on its own. A student has none of these.
 */
export function removeMember(db: Db, scope: ClassManagerScope, userId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(classMemberships)
      .where(realMember(scope, userId))
      .returning({ role: classMemberships.role, manageMembers: classMemberships.manageMembers });
    if (!removed) return { ok: false as const };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'membership.remove',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'user',
      targetId: userId,
      before: removed,
      after: { via: scope.via },
    });
    if (removed.role === 'instructor') {
      await dropPreviews(tx, scope, userId, now);
      const course = await lockCourseMembership(tx, scope, userId);
      await dropEditorIfNotTeaching(tx, scope, userId, course);
      if (!course?.owner) await revokeIssuedBy(tx, scope, userId, now, 'issuer_removed');
    }
    return { ok: true as const };
  });
}

/** The instructor's preview principals lose their membership in the class and their sessions. */
async function dropPreviews(tx: Tx, scope: ClassManagerScope, userId: string, now: Date) {
  const previews = tx.select({ id: users.id }).from(users).where(eq(users.ownerUserId, userId));
  const dropped = await tx
    .delete(classMemberships)
    .where(
      and(
        forClass(scope, classMemberships),
        eq(classMemberships.isPreview, true),
        inArray(classMemberships.userId, previews),
      ),
    )
    .returning({ userId: classMemberships.userId, role: classMemberships.role });
  if (dropped.length === 0) return;
  // The preview user row stays (later records and audit events may name it), but it can no
  // longer sign anything in.
  const ids = dropped.map((d) => d.userId);
  await tx
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(inArray(authSessions.userId, ids), isNull(authSessions.revokedAt)));
  for (const preview of dropped) {
    await audit(tx, {
      actorId: scope.user.id,
      action: 'membership.remove',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'user',
      targetId: preview.userId,
      before: { role: preview.role, isPreview: true },
      after: { via: scope.via, previewOf: userId },
    });
  }
}

/**
 * Locks the person's course membership row, so a removal deciding whether they still teach the
 * course and an invitation acceptance re-granting draft editing run one after the other. Its
 * owner flag also decides whether the person's invitations outlive their class authority.
 */
async function lockCourseMembership(tx: Tx, scope: CourseContext, userId: string) {
  const [row] = await tx
    .select({
      owner: courseMemberships.owner,
      editor: courseMemberships.editor,
      publisher: courseMemberships.publisher,
    })
    .from(courseMemberships)
    .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId)))
    .for('update');
  return row;
}

/** `current` is the person's course membership, read under `lockCourseMembership`. */
async function dropEditorIfNotTeaching(
  tx: Tx,
  scope: ClassManagerScope,
  userId: string,
  current: Awaited<ReturnType<typeof lockCourseMembership>>,
) {
  if (!current?.editor || current.owner) return;
  const [teaching] = await tx
    .select({ id: classMemberships.id })
    .from(classMemberships)
    .innerJoin(classes, eq(classes.id, classMemberships.classId))
    .where(
      and(
        forCourse(scope, classes),
        eq(classMemberships.userId, userId),
        eq(classMemberships.role, 'instructor'),
      ),
    )
    .limit(1);
  if (teaching) return;
  await tx
    .update(courseMemberships)
    .set({ editor: false })
    .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId)));
  const membershipRemoved = await tryDeleteEmpty(tx, scope, userId);
  await audit(tx, {
    actorId: scope.user.id,
    action: 'grant.editor',
    scopeKind: 'course',
    scopeId: scope.courseId,
    targetType: 'user',
    targetId: userId,
    before: { editor: true },
    after: { editor: false, membershipRemoved, via: scope.via },
  });
}

/** A course membership holding no grant carries no meaning; drop it. True when it was dropped. */
async function tryDeleteEmpty(tx: Tx, scope: CourseContext, userId: string): Promise<boolean> {
  const deleted = await tx
    .delete(courseMemberships)
    .where(
      and(
        forCourse(scope, courseMemberships),
        eq(courseMemberships.userId, userId),
        eq(courseMemberships.owner, false),
        eq(courseMemberships.editor, false),
        eq(courseMemberships.publisher, false),
      ),
    )
    .returning({ id: courseMemberships.id });
  return deleted.length > 0;
}

/**
 * Instructor invitations rest on their issuer's authority: once a person can no longer manage
 * the class (removed, or `manage_members` revoked), the open instructor invitations they issued
 * there are revoked. Callers skip a course owner, who keeps that authority through the course.
 * Enrolment codes belong to the class and stay; a manager withdraws one explicitly. Expired and
 * used-up invitations are left as they are, with no event.
 */
function revokeIssuedBy(
  tx: Tx,
  scope: ClassManagerScope,
  userId: string,
  now: Date,
  reason: RevokeReason,
) {
  const issued = and(
    eq(classInvites.createdBy, userId),
    eq(classInvites.kind, 'instructor'),
    openInvite(now),
  ) as SQL;
  return revokeInvites(tx, scope, issued, now, { reason });
}

/** Publication is a course grant only the owner hands out (§3: "If delegated"). */
export function setPublisher(db: Db, scope: CourseScope, userId: string, granted: boolean) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
    if (user?.kind !== 'user') return { ok: false as const, reason: 'not_found' as const };
    const current = await lockCourseMembership(tx, scope, userId);
    if (current?.owner) return { ok: false as const, reason: 'owner' as const };
    // Nothing changes, so nothing is recorded (audit_events holds changes only).
    if ((current?.publisher ?? false) === granted) return { ok: true as const };
    let membershipRemoved = false;
    if (granted) {
      await tx
        .insert(courseMemberships)
        .values({ courseId: scope.courseId, userId, publisher: true })
        .onConflictDoUpdate({
          target: [courseMemberships.courseId, courseMemberships.userId],
          set: { publisher: true },
        });
    } else if (current) {
      await tx
        .update(courseMemberships)
        .set({ publisher: false })
        .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId)));
      membershipRemoved = await tryDeleteEmpty(tx, scope, userId);
    }
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grant.publisher',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'user',
      targetId: userId,
      before: { publisher: current?.publisher ?? false },
      after: { publisher: granted, membershipRemoved },
    });
    return { ok: true as const };
  });
}
