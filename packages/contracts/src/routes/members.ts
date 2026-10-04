import { z } from 'zod';
import { classArchived, defineRoute, errorBody } from '../define';
import { exampleIds } from '../examples';

const zero = exampleIds.zero;
const classParams = z.object({ classId: z.uuid() });
const memberParams = z.object({ classId: z.uuid(), userId: z.uuid() });
const datetime = z.iso.datetime({ offset: true });
/** Who manages a class's membership (§3): the course owner, or an instructor with the grant. */
const managers = { kind: 'class', role: 'instructor', grant: 'manage_members' } as const;

/** Why an invitation could not be used; the join screen states the cause (§4). */
export const inviteFailure = z.enum([
  'invite_not_found',
  'invite_revoked',
  'invite_expired',
  'invite_full',
  'invite_other_account',
  'class_archived',
  'already_member',
]);
const inviteRefusal = z.object({ error: inviteFailure });
/** Joining is limited per session (members.routes.ts). */
const limited = { 429: errorBody };

export const createClass = defineRoute({
  method: 'POST',
  path: '/api/courses/:courseId/classes',
  scope: { kind: 'course', role: 'owner' },
  summary: 'Create a class (cohort) of the course; it adopts a release separately',
  params: z.object({ courseId: z.uuid() }),
  body: z.object({ name: z.string().trim().min(1).max(120) }),
  response: z.object({ id: z.uuid(), courseId: z.uuid(), name: z.string() }),
  examples: { params: { courseId: zero }, body: { name: 'Spring 2027' } },
});

const issuedInvite = z.object({
  id: z.uuid(),
  kind: z.enum(['enrolment', 'instructor']),
  email: z.string().nullable(),
  expiresAt: datetime.nullable(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  createdAt: datetime,
});

/**
 * The code is returned once and only its hash is stored. An enrolment code can only ever
 * create student memberships; an instructor invitation is addressed to one email and
 * single-use (§3). 409 `class_archived`; 400 `expiry_in_past`. Needs a recent sign-in.
 */
export const createInvite = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/invites',
  scope: managers,
  summary: 'Issue a student enrolment code or an instructor invitation for the class',
  params: classParams,
  body: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('enrolment'),
      expiresAt: datetime.nullable().optional(),
      maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
    }),
    z.object({
      kind: z.literal('instructor'),
      email: z.email(),
      /** Defaults to seven days; an instructor invitation always expires. */
      expiresAt: datetime.optional(),
    }),
  ]),
  response: issuedInvite.extend({ code: z.string() }),
  errors: { 400: z.object({ error: z.literal('expiry_in_past') }), 409: classArchived },
  examples: { params: { classId: zero }, body: { kind: 'enrolment', maxUses: 30 } },
});

/**
 * Later uses of the invitation are refused with `invite_revoked`. 404 for an invitation of
 * another class. Revoking twice changes nothing. Needs a recent sign-in.
 */
export const revokeInvite = defineRoute({
  method: 'DELETE',
  path: '/api/classes/:classId/invites/:inviteId',
  scope: managers,
  summary: 'Revoke an enrolment code or instructor invitation of the class',
  params: z.object({ classId: z.uuid(), inviteId: z.uuid() }),
  response: z.object({ id: z.uuid(), revokedAt: datetime }),
  examples: { params: { classId: zero, inviteId: zero } },
});

export const listMembers = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/members',
  scope: managers,
  summary: 'Members of the class with their grants, and its open invitations',
  params: classParams,
  response: z.object({
    members: z.array(
      z.object({
        userId: z.uuid(),
        name: z.string(),
        email: z.string().nullable(),
        role: z.enum(['student', 'instructor']),
        manageMembers: z.boolean(),
      }),
    ),
    invites: z.array(issuedInvite),
  }),
  examples: { params: { classId: zero } },
});

/**
 * Revoking the grant also revokes the open instructor invitations the instructor issued in the
 * class, unless they own the course; granting again restores none. Enrolment codes belong to the
 * class and keep working. 404 when the user is not a member; 409 `not_instructor`. Needs a recent
 * sign-in.
 */
export const setManageMembers = defineRoute({
  method: 'PUT',
  path: '/api/classes/:classId/members/:userId/manage-members',
  scope: managers,
  summary: 'Grant or revoke membership management for one instructor of the class',
  params: memberParams,
  body: z.object({ granted: z.boolean() }),
  response: z.object({ userId: z.uuid(), manageMembers: z.boolean() }),
  errors: { 409: z.object({ error: z.literal('not_instructor') }) },
  examples: { params: { classId: zero, userId: zero }, body: { granted: true } },
});

/**
 * Removing an instructor also removes their preview principal in the class, and their draft
 * editing once they teach no class of the course. Open instructor invitations they issued in the
 * class are revoked unless they own the course; enrolment codes belong to the class and keep
 * working. 404 when not a member. Needs a recent sign-in.
 */
export const removeMember = defineRoute({
  method: 'DELETE',
  path: '/api/classes/:classId/members/:userId',
  scope: managers,
  summary: 'Remove a student or instructor from the class',
  params: memberParams,
  response: z.object({ removed: z.literal(true) }),
  examples: { params: { classId: zero, userId: zero } },
});

/** 404 for an unknown account; 409 `owner` (owners hold every grant). Needs a recent sign-in. */
export const setPublisher = defineRoute({
  method: 'PUT',
  path: '/api/courses/:courseId/members/:userId/publisher',
  scope: { kind: 'course', role: 'owner' },
  summary: 'Grant or revoke the right to publish releases of the course',
  params: z.object({ courseId: z.uuid(), userId: z.uuid() }),
  body: z.object({ granted: z.boolean() }),
  response: z.object({ userId: z.uuid(), publisher: z.boolean() }),
  errors: { 409: z.object({ error: z.literal('owner') }) },
  examples: { params: { courseId: zero, userId: zero }, body: { granted: true } },
});

const joined = z.object({
  classId: z.uuid(),
  className: z.string(),
  courseId: z.uuid(),
  courseTitle: z.string(),
  role: z.enum(['student', 'instructor']),
  /** True when the account was already a member; the invitation was not used up. */
  alreadyMember: z.boolean(),
});

/**
 * Enrolment codes only: creates a student membership, or reports the existing one. Refusals are `{ error: <inviteFailure> }`
 * with 404 (unknown code), 410 (revoked, expired) or 409 (full, archived class).
 */
export const joinClass = defineRoute({
  method: 'POST',
  path: '/api/join',
  scope: { kind: 'user' },
  summary: 'Join a class as a student with an enrolment code',
  body: z.object({ code: z.string().trim().min(1).max(64) }),
  response: joined,
  errors: { 404: inviteRefusal, 409: inviteRefusal, 410: inviteRefusal, ...limited },
  examples: { body: { code: 'ABCDE-FGHJK' } },
});

/**
 * Instructor invitations only, for the account whose email they name (403
 * `invite_other_account`). Grants the class instructor role and course draft editing (§3).
 * 409 `already_member` when the account is a student of the class.
 */
export const acceptInvitation = defineRoute({
  method: 'POST',
  path: '/api/invitations/accept',
  scope: { kind: 'user' },
  summary: 'Accept an instructor invitation addressed to the signed-in account',
  body: z.object({ token: z.string().trim().min(1).max(64) }),
  response: joined.extend({ role: z.literal('instructor') }),
  errors: {
    403: inviteRefusal,
    404: inviteRefusal,
    409: inviteRefusal,
    410: inviteRefusal,
    ...limited,
  },
  examples: { body: { token: 'x'.repeat(43) } },
});
