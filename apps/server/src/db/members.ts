import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { ClassManagerScope, CourseScope } from '../auth/scope';
import type { Db } from './client';
import { audit, type Tx } from './identity';
import {
  authSessions,
  classes,
  classInvites,
  classMemberships,
  courseMemberships,
  users,
} from './schema';
import { forClass, forCourse } from './scoped';

/** Real members of the class (preview principals excluded) and its unrevoked invitations. */
export async function listMembers(db: Db, scope: ClassManagerScope) {
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
    .where(and(forClass(scope, classInvites), isNull(classInvites.revokedAt)))
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
    return { ok: true as const };
  });
}

/**
 * Removes one membership. An instructor's preview membership in the class goes with them (its
 * sessions revoked), and
 * the draft editing their invitation granted ends once they teach no class of the course.
 */
export function removeMember(db: Db, scope: ClassManagerScope, userId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(classMemberships)
      .where(realMember(scope, userId))
      .returning({ role: classMemberships.role, manageMembers: classMemberships.manageMembers });
    if (!removed) return { ok: false as const };
    if (removed.role === 'instructor') {
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
        .returning({ userId: classMemberships.userId });
      // The preview user row stays (later records and audit events may name it), but it can no
      // longer sign anything in.
      if (dropped.length > 0) {
        const ids = dropped.map((d) => d.userId);
        await tx
          .update(authSessions)
          .set({ revokedAt: now })
          .where(and(inArray(authSessions.userId, ids), isNull(authSessions.revokedAt)));
      }
      await dropEditorIfNotTeaching(tx, scope.courseId, userId);
    }
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
    return { ok: true as const };
  });
}

async function dropEditorIfNotTeaching(tx: Tx, courseId: string, userId: string) {
  const [teaching] = await tx
    .select({ id: classMemberships.id })
    .from(classMemberships)
    .innerJoin(classes, eq(classes.id, classMemberships.classId))
    .where(
      and(
        eq(classes.courseId, courseId),
        eq(classMemberships.userId, userId),
        eq(classMemberships.role, 'instructor'),
      ),
    )
    .limit(1);
  if (teaching) return;
  const course = and(
    eq(courseMemberships.courseId, courseId),
    eq(courseMemberships.userId, userId),
  );
  await tx
    .update(courseMemberships)
    .set({ editor: false })
    .where(and(course, eq(courseMemberships.owner, false)));
  await tryDeleteEmpty(tx, courseId, userId);
}

/** A course membership holding no grant carries no meaning; drop it. */
async function tryDeleteEmpty(tx: Tx, courseId: string, userId: string) {
  await tx
    .delete(courseMemberships)
    .where(
      and(
        eq(courseMemberships.courseId, courseId),
        eq(courseMemberships.userId, userId),
        eq(courseMemberships.owner, false),
        eq(courseMemberships.editor, false),
        eq(courseMemberships.publisher, false),
      ),
    );
}

/** Publication is a course grant only the owner hands out (§3: "If delegated"). */
export function setPublisher(db: Db, scope: CourseScope, userId: string, granted: boolean) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
    if (user?.kind !== 'user') return { ok: false as const, reason: 'not_found' as const };
    const [current] = await tx
      .select({ owner: courseMemberships.owner, publisher: courseMemberships.publisher })
      .from(courseMemberships)
      .where(and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId)))
      .for('update');
    if (current?.owner) return { ok: false as const, reason: 'owner' as const };
    // Nothing changes, so nothing is recorded (audit_events holds changes only).
    if ((current?.publisher ?? false) === granted) return { ok: true as const };
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
      await tryDeleteEmpty(tx, scope.courseId, userId);
    }
    await audit(tx, {
      actorId: scope.user.id,
      action: 'grant.publisher',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'user',
      targetId: userId,
      before: { publisher: current?.publisher ?? false },
      after: { publisher: granted },
    });
    return { ok: true as const };
  });
}
