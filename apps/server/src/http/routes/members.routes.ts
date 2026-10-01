import {
  acceptInvitation,
  createClass,
  createInvite,
  joinClass,
  listMembers,
  removeMember,
  setManageMembers,
  setPublisher,
} from '@parallax/contracts/routes/members';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../../app';
import { SESSION_COOKIE } from '../../auth/sessions';
import * as identity from '../../db/identity';
import * as invites from '../../membership/invites';
import * as members from '../../membership/members';
import { notFound, registerRoute } from '../register';

/** HTTP status for each reason an invitation cannot be used (§4: the cause is shown). */
const inviteStatus: Record<invites.InviteFailure, number> = {
  invite_not_found: 404,
  invite_revoked: 410,
  invite_expired: 410,
  invite_full: 409,
  invite_other_account: 403,
  class_archived: 409,
  already_member: 409,
};

/** Error replies carry a body the contract's success schema does not describe. */
const fail = (reply: FastifyReply, status: number, error: string) =>
  reply.code(status).send({ error }) as never;

const iso = (d: Date | null) => d?.toISOString() ?? null;
const inviteView = <T extends { expiresAt: Date | null; createdAt: Date }>(i: T) => ({
  ...i,
  expiresAt: iso(i.expiresAt),
  createdAt: i.createdAt.toISOString(),
});

export default function memberRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => app.resolverDeps.now();

  registerRoute(app, createClass, async ({ scope, body }) => {
    const created = await identity.createClass(db(), scope, { name: body.name });
    return { ...created, courseId: scope.courseId };
  });

  registerRoute(app, createInvite, async ({ scope, body, reply }) => {
    scope.requireRecentAuth();
    const result = await invites.issueInvite(db(), scope, body, now());
    if (!result.ok)
      return fail(reply, result.reason === 'class_archived' ? 409 : 400, result.reason);
    return inviteView(result.invite);
  });

  registerRoute(app, listMembers, async ({ scope }) => {
    const list = await members.listMembers(db(), scope);
    return { members: list.members, invites: list.invites.map(inviteView) };
  });

  registerRoute(app, setManageMembers, async ({ scope, params, body, reply }) => {
    scope.requireRecentAuth();
    const result = await members.setManageMembers(db(), scope, params.userId, body.granted);
    if (!result.ok)
      return result.reason === 'not_found' ? notFound() : fail(reply, 409, result.reason);
    return { userId: params.userId, manageMembers: body.granted };
  });

  registerRoute(app, removeMember, async ({ scope, params }) => {
    scope.requireRecentAuth();
    const result = await members.removeMember(db(), scope, params.userId);
    if (!result.ok) return notFound();
    return { removed: true as const };
  });

  registerRoute(app, setPublisher, async ({ scope, params, body, reply }) => {
    scope.requireRecentAuth();
    const result = await members.setPublisher(db(), scope, params.userId, body.granted);
    if (!result.ok) return result.reason === 'not_found' ? notFound() : fail(reply, 409, 'owner');
    return { userId: params.userId, publisher: body.granted };
  });

  // Brute-forcing codes is limited per session, not per address: a whole lecture hall may join
  // from one network address at once. Sessions come only from rate-limited sign-in links.
  const joinLimit = {
    rateLimit: {
      max: 20,
      timeWindow: '15 minutes',
      keyGenerator: (req: FastifyRequest) => req.cookies[SESSION_COOKIE] ?? req.ip,
    },
  };

  registerRoute(
    app,
    joinClass,
    async ({ scope, body, reply }) => {
      const result = await invites.joinWithCode(db(), scope, body.code, now());
      if (!result.ok) return fail(reply, inviteStatus[result.reason], result.reason);
      return { ...result.joined, role: result.role };
    },
    joinLimit,
  );

  registerRoute(
    app,
    acceptInvitation,
    async ({ scope, body, reply }) => {
      const result = await invites.acceptInstructorInvite(db(), scope, body.token, now());
      if (!result.ok) return fail(reply, inviteStatus[result.reason], result.reason);
      return { ...result.joined, role: result.role };
    },
    joinLimit,
  );
}
