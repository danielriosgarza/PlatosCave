import { randomInt } from 'node:crypto';
import type { inviteFailure } from '@parallax/contracts/routes/members';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassManagerScope, UserScope } from '../auth/scope';
import { hashToken, newToken } from '../auth/sessions';
import type { Db } from './client';
import { audit, type Tx } from './identity';
import {
  classes,
  classInvites,
  classMemberships,
  courseMemberships,
  courses,
  users,
} from './schema';

export type InviteFailure = z.infer<typeof inviteFailure>;

/** Instructor invitations expire after a week unless the issuer chooses otherwise. */
export const INSTRUCTOR_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Without the look-alikes 0/O and 1/I/L: 31 symbols, so ten give about 49 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

/** A typeable enrolment code, shown as `ABCDE-FGHJK`. */
export function newEnrolmentCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Codes are compared case-insensitively and without separators, as people retype them. */
export const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

const inviteColumns = {
  id: classInvites.id,
  kind: classInvites.kind,
  email: classInvites.email,
  expiresAt: classInvites.expiresAt,
  maxUses: classInvites.maxUses,
  useCount: classInvites.useCount,
  createdAt: classInvites.createdAt,
};

export type IssueInput =
  | { kind: 'enrolment'; expiresAt?: string | null; maxUses?: number | null }
  | { kind: 'instructor'; email: string; expiresAt?: string };

export async function issueInvite(db: Db, scope: ClassManagerScope, input: IssueInput, now: Date) {
  if (scope.archived) return { ok: false as const, reason: 'class_archived' as const };
  const instructor = input.kind === 'instructor';
  const expiresAt = input.expiresAt
    ? new Date(input.expiresAt)
    : instructor
      ? new Date(now.getTime() + INSTRUCTOR_INVITE_TTL_MS)
      : null;
  if (expiresAt && expiresAt <= now)
    return { ok: false as const, reason: 'expiry_in_past' as const };
  const code = instructor ? newToken() : newEnrolmentCode();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(classInvites)
      .values({
        classId: scope.classId,
        kind: input.kind,
        codeHash: hashToken(instructor ? code : normaliseCode(code)),
        email: instructor ? input.email.toLowerCase() : null,
        createdBy: scope.user.id,
        expiresAt,
        maxUses: instructor ? 1 : (input.maxUses ?? null),
        createdAt: now,
      })
      .returning(inviteColumns);
    if (!row) throw new Error('invite insert returned no row');
    await audit(tx, {
      actorId: scope.user.id,
      action: 'invite.create',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'invite',
      targetId: row.id,
      after: { kind: row.kind, email: row.email, expiresAt, maxUses: row.maxUses, via: scope.via },
    });
    return { ok: true as const, invite: { ...row, code } };
  });
}

type Joined = {
  classId: string;
  className: string;
  courseId: string;
  courseTitle: string;
  alreadyMember: boolean;
};
type Outcome<R> = { ok: true; role: R; joined: Joined } | { ok: false; reason: InviteFailure };

/**
 * Locks the invitation row of `kind` matching `codeHash`, so concurrent uses are counted one
 * at a time against its capacity.
 */
async function lockInvite(tx: Tx, kind: 'enrolment' | 'instructor', codeHash: string) {
  const [row] = await tx
    .select({
      ...inviteColumns,
      revokedAt: classInvites.revokedAt,
      classId: classes.id,
      className: classes.name,
      archivedAt: classes.archivedAt,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(classInvites)
    .innerJoin(classes, eq(classes.id, classInvites.classId))
    .innerJoin(courses, eq(courses.id, classes.courseId))
    .where(and(eq(classInvites.codeHash, codeHash), eq(classInvites.kind, kind)))
    .for('update', { of: classInvites });
  return row;
}

type Invite = NonNullable<Awaited<ReturnType<typeof lockInvite>>>;

function unusable(invite: Invite | undefined, now: Date): InviteFailure | null {
  if (!invite) return 'invite_not_found';
  if (invite.revokedAt) return 'invite_revoked';
  if (invite.expiresAt && invite.expiresAt <= now) return 'invite_expired';
  if (invite.archivedAt) return 'class_archived';
  return null;
}

const full = (invite: Invite) => invite.maxUses !== null && invite.useCount >= invite.maxUses;

/** Counts one use and records who joined through which invitation. */
async function recordUse(tx: Tx, invite: Invite, userId: string, after: Record<string, unknown>) {
  await tx
    .update(classInvites)
    .set({ useCount: sql`${classInvites.useCount} + 1` })
    .where(eq(classInvites.id, invite.id));
  await audit(tx, {
    actorId: userId,
    action: 'membership.add',
    scopeKind: 'class',
    scopeId: invite.classId,
    targetType: 'user',
    targetId: userId,
    after: { ...after, inviteId: invite.id },
  });
}

const joinedFrom = (invite: Invite, alreadyMember: boolean): Joined => ({
  classId: invite.classId,
  className: invite.className,
  courseId: invite.courseId,
  courseTitle: invite.courseTitle,
  alreadyMember,
});

async function existingRole(tx: Tx, classId: string, userId: string) {
  const [row] = await tx
    .select({ role: classMemberships.role })
    .from(classMemberships)
    .where(and(eq(classMemberships.classId, classId), eq(classMemberships.userId, userId)));
  return row?.role;
}

/**
 * Inserts the membership unless one exists; false when a concurrent request of the same account
 * got there first, so the unique (class, user) key never surfaces as a server error.
 */
async function insertMembership(
  tx: Tx,
  classId: string,
  userId: string,
  role: 'student' | 'instructor',
): Promise<boolean> {
  const rows = await tx
    .insert(classMemberships)
    .values({ classId, userId, role })
    .onConflictDoNothing({ target: [classMemberships.classId, classMemberships.userId] })
    .returning({ id: classMemberships.id });
  return rows.length > 0;
}

/** Only real accounts join; a preview principal never gets a membership from a code. */
async function isRealUser(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  return row?.kind === 'user';
}

/**
 * Enrolment code → student membership; the only path this function has (§3: a student
 * enrolment code never grants instructor access). An existing membership is left as it is.
 */
export function joinWithCode(
  db: Db,
  scope: UserScope,
  code: string,
  now: Date,
): Promise<Outcome<'student' | 'instructor'>> {
  return db.transaction(async (tx) => {
    const invite = await lockInvite(tx, 'enrolment', hashToken(normaliseCode(code)));
    const failure = unusable(invite, now);
    if (failure || !invite) return { ok: false, reason: failure ?? 'invite_not_found' };
    if (!(await isRealUser(tx, scope.user.id))) return { ok: false, reason: 'invite_not_found' };
    const role = await existingRole(tx, invite.classId, scope.user.id);
    if (role) return { ok: true, role, joined: joinedFrom(invite, true) };
    if (full(invite)) return { ok: false, reason: 'invite_full' };
    const inserted = await insertMembership(tx, invite.classId, scope.user.id, 'student');
    if (!inserted) {
      // Another request of this account joined the class since the check above.
      const current = await existingRole(tx, invite.classId, scope.user.id);
      return { ok: true, role: current ?? 'student', joined: joinedFrom(invite, true) };
    }
    await recordUse(tx, invite, scope.user.id, { role: 'student' });
    return { ok: true, role: 'student', joined: joinedFrom(invite, false) };
  });
}

/**
 * Instructor invitation → class instructor membership plus draft editing on its course;
 * publication and membership management stay separate grants (§3, ADR-0002).
 */
export function acceptInstructorInvite(
  db: Db,
  scope: UserScope,
  token: string,
  now: Date,
): Promise<Outcome<'instructor'>> {
  return db.transaction(async (tx) => {
    const invite = await lockInvite(tx, 'instructor', hashToken(token));
    const failure = unusable(invite, now);
    if (failure || !invite) return { ok: false, reason: failure ?? 'invite_not_found' };
    if (!(await isRealUser(tx, scope.user.id)) || invite.email !== scope.user.email) {
      return { ok: false, reason: 'invite_other_account' };
    }
    const role = await existingRole(tx, invite.classId, scope.user.id);
    if (role === 'instructor') return { ok: true, role, joined: joinedFrom(invite, true) };
    if (role) return { ok: false, reason: 'already_member' };
    if (full(invite)) return { ok: false, reason: 'invite_full' };
    if (!(await insertMembership(tx, invite.classId, scope.user.id, 'instructor'))) {
      // Another request of this account joined the class since the check above.
      const current = await existingRole(tx, invite.classId, scope.user.id);
      if (current === 'instructor')
        return { ok: true, role: current, joined: joinedFrom(invite, true) };
      return { ok: false, reason: 'already_member' };
    }
    await tx
      .insert(courseMemberships)
      .values({ courseId: invite.courseId, userId: scope.user.id, editor: true })
      .onConflictDoUpdate({
        target: [courseMemberships.courseId, courseMemberships.userId],
        set: { editor: true },
      });
    await recordUse(tx, invite, scope.user.id, { role: 'instructor', courseEditor: true });
    return { ok: true, role: 'instructor', joined: joinedFrom(invite, false) };
  });
}
