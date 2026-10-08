import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { ClassManagerScope, CourseContext, CourseScope } from '../auth/scope';
import { audit } from './audit';
import type { Db, Tx } from './client';
import { otherActiveOwnerExists } from './courseOwners';
import { cancelSamplesOfRemoved } from './execution/runs';
import { auditRevoked, openInvite, type RevokeReason, revokeInvites } from './invites';
import { closeForRemovedMembers } from './notebooks/sessions';
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
      await revokeIssuedBy(tx, scope, userId, course, now, 'issuer_lost_manage_members');
    }
    return { ok: true as const };
  });
}

/**
 * Removes one membership. The person's open notebook sessions in the class close and their queued
 * sample runs there are cancelled (ADR-0002 "Permission revoked"); `cancelledJobs` are the run
 * jobs the caller cancels on the runner's queue after the commit. An instructor's preview
 * membership in the class goes with them (its sign-in sessions revoked, its notebook sessions and
 * runs ended the same way), the draft editing their invitation granted ends once they teach no
 * class of the course, and the open instructor invitations they issued in the class are revoked
 * unless they own the course. Each cascade is audited on its own.
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
    const gone = [userId];
    if (removed.role === 'instructor') {
      gone.push(...(await dropPreviews(tx, scope, userId, now)));
      const course = await lockCourseMembership(tx, scope, userId);
      await dropEditorIfNotTeaching(tx, scope, userId, course);
      await revokeIssuedBy(tx, scope, userId, course, now, 'issuer_removed');
    }
    await closeForRemovedMembers(tx, scope, gone, now);
    const cancelledJobs = await cancelSamplesOfRemoved(tx, scope, gone, now);
    return { ok: true as const, cancelledJobs };
  });
}

/**
 * The instructor's preview principals lose their membership in the class and their sign-in
 * sessions. Resolves with their ids.
 */
async function dropPreviews(
  tx: Tx,
  scope: ClassManagerScope,
  userId: string,
  now: Date,
): Promise<string[]> {
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
  if (dropped.length === 0) return [];
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
  return ids;
}

/**
 * Locks the person's course membership row, so a removal deciding whether they still teach the
 * course and an invitation acceptance re-granting draft editing run one after the other. Its
 * owner flag also decides whether the person's invitations outlive their class authority
 * (`revokeIssuedBy`). The grant toggle reads `owner` through it only to share that one code
 * path; `setOwner` is what writes `owner`, and it serialises on the course's owner rows itself.
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
  scope: CourseContext,
  userId: string,
  current: Awaited<ReturnType<typeof lockCourseMembership>>,
): Promise<boolean | null> {
  if (!current?.editor || current.owner) return null;
  if (await teachesCourse(tx, scope, userId)) return null;
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
    after: { editor: false, membershipRemoved, ...('via' in scope && { via: scope.via }) },
  });
  return membershipRemoved;
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
 * there are revoked, except a course owner's, who keeps that authority through the course.
 * `course` is the person's course membership, read under `lockCourseMembership`. Enrolment codes
 * belong to the class and stay; a manager withdraws one explicitly. Expired and used-up
 * invitations are left as they are, with no event.
 */
async function revokeIssuedBy(
  tx: Tx,
  scope: ClassManagerScope,
  userId: string,
  course: Awaited<ReturnType<typeof lockCourseMembership>>,
  now: Date,
  reason: RevokeReason,
): Promise<void> {
  if (course?.owner) return;
  const issued = and(
    eq(classInvites.createdBy, userId),
    eq(classInvites.kind, 'instructor'),
    openInvite(now),
  ) as SQL;
  await revokeInvites(tx, scope, issued, now, { reason });
}

/** Whether the person holds an instructor seat in a class of the course. */
async function teachesCourse(tx: Tx, scope: CourseContext, userId: string): Promise<boolean> {
  const [teaching] = await tx
    .select({ id: classMemberships.id })
    .from(classMemberships)
    .innerJoin(classes, eq(classes.id, classMemberships.classId))
    .where(
      and(
        forCourse(scope, classes),
        eq(classMemberships.userId, userId),
        eq(classMemberships.role, 'instructor'),
        eq(classMemberships.isPreview, false),
      ),
    )
    .limit(1);
  return teaching !== undefined;
}

/**
 * Grants or withdraws course ownership (§3). Locks are taken in the order `closeAccount` takes
 * them: the target's account row, then every owner membership of the course in id order. Two
 * owners withdrawing each other, or one closing their account meanwhile, therefore run one after
 * the other without deadlocking and the course keeps an active owner (`otherActiveOwnerExists`).
 * The caller's own ownership is confirmed under those locks, because the role the route resolved
 * may have been withdrawn while this request waited.
 */
export function setOwner(db: Db, scope: CourseScope, userId: string, granted: boolean, now: Date) {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ kind: users.kind, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    const owners = await tx
      .select({ userId: courseMemberships.userId, deactivatedAt: users.deactivatedAt })
      .from(courseMemberships)
      .innerJoin(users, eq(users.id, courseMemberships.userId))
      .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.owner, true)))
      .orderBy(asc(courseMemberships.id))
      .for('update', { of: courseMemberships });
    if (!owners.some((o) => o.userId === scope.user.id && o.deactivatedAt === null))
      return { ok: false as const, reason: 'not_owner' as const };
    if (user?.kind !== 'user') return { ok: false as const, reason: 'not_found' as const };
    const current = await lockCourseMembership(tx, scope, userId);
    if (granted) {
      if (user.deactivatedAt !== null) return { ok: false as const, reason: 'not_found' as const };
      if (current?.owner) return { ok: true as const };
      // Owners are instructors (§3): someone who teaches a class of the course or holds draft editing.
      if (!current?.editor && !(await teachesCourse(tx, scope, userId)))
        return { ok: false as const, reason: 'not_course_staff' as const };
    } else {
      if (!current?.owner) return { ok: true as const };
      const { rows } = await tx.execute<{ other: boolean }>(
        sql`select ${otherActiveOwnerExists(scope.courseId, userId)} as other`,
      );
      if (!rows[0]?.other) return { ok: false as const, reason: 'last_owner' as const };
    }
    let membershipRemoved = false;
    if (granted) {
      // Teaching a class already carries draft editing (§3); a new row keeps that.
      await tx
        .insert(courseMemberships)
        .values({ courseId: scope.courseId, userId, owner: true, editor: true })
        .onConflictDoUpdate({
          target: [courseMemberships.courseId, courseMemberships.userId],
          set: { owner: true, editor: true },
        });
    } else {
      await tx
        .update(courseMemberships)
        .set({ owner: false })
        .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId)));
      // Outside the owner's exemption, draft editing lasts only while teaching a class (§3), and
      // nobody could take it away from a creator who never taught.
      const editorDropped = await dropEditorIfNotTeaching(tx, scope, userId, {
        owner: false,
        editor: current?.editor ?? false,
        publisher: current?.publisher ?? false,
      });
      membershipRemoved = editorDropped ?? (await tryDeleteEmpty(tx, scope, userId));
    }
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grant.owner',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'user',
      targetId: userId,
      before: { owner: current?.owner ?? false },
      after: { owner: granted, membershipRemoved },
    });
    if (!granted) await revokeOwnerInvites(tx, scope, userId, now);
    return { ok: true as const };
  });
}

/**
 * Instructor invitations rest on their issuer's authority (`revokeIssuedBy`), and an owner issues
 * through the course. Once that is withdrawn, the open instructor invitations the person issued
 * in classes of the course are revoked, except where they still hold `manage_members`. Each is
 * audited like the other cascades.
 */
async function revokeOwnerInvites(tx: Tx, scope: CourseScope, userId: string, now: Date) {
  const lapsed = await tx
    .update(classInvites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(classInvites.createdBy, userId),
        eq(classInvites.kind, 'instructor'),
        openInvite(now),
        inArray(
          classInvites.classId,
          tx.select({ id: classes.id }).from(classes).where(forCourse(scope, classes)),
        ),
        sql`not exists (select 1 from ${classMemberships} m
          where m.class_id = ${classInvites.classId} and m.user_id = ${userId}
            and m.manage_members and not m.is_preview)`,
      ),
    )
    .returning({ id: classInvites.id, classId: classInvites.classId });
  await auditRevoked(tx, lapsed, scope.user.id, 'course_owner', now, {
    reason: 'issuer_lost_ownership',
  });
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
