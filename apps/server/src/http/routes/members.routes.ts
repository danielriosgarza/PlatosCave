import {
  acceptInvitation,
  createClass,
  createInvite,
  joinClass,
  listMembers,
  removeMember,
  revokeInvite,
  setManageMembers,
  setPublisher,
} from '@parallax/contracts/routes/members';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../../app';
import { hashToken, readSessionToken } from '../../auth/sessions';
import * as identity from '../../db/identity';
import * as invites from '../../db/invites';
import * as members from '../../db/members';
import { notFound, refuse, registerRoute } from '../register';

/** HTTP status for each reason an invitation cannot be used (§4: the cause is shown). */
const inviteStatus: Record<invites.InviteFailure, 403 | 404 | 409 | 410> = {
  invite_not_found: 404,
  invite_revoked: 410,
  invite_expired: 410,
  invite_full: 409,
  invite_other_account: 403,
  class_archived: 409,
  already_member: 409,
};

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

  registerRoute(app, createInvite, async ({ scope, body }) => {
    scope.requireRecentAuth();
    const result = await invites.issueInvite(db(), scope, body, now());
    if (!result.ok) return refuse(result.reason === 'class_archived' ? 409 : 400, result.reason);
    return inviteView(result.invite);
  });

  registerRoute(app, revokeInvite, async ({ scope, params }) => {
    scope.requireRecentAuth();
    const result = await invites.revokeInvite(db(), scope, params.inviteId, now());
    if (!result.ok) return notFound();
    return { id: params.inviteId, revokedAt: result.revokedAt.toISOString() };
  });

  registerRoute(app, listMembers, async ({ scope }) => {
    const list = await members.listMembers(db(), scope, now());
    return { members: list.members, invites: list.invites.map(inviteView) };
  });

  registerRoute(app, setManageMembers, async ({ scope, params, body }) => {
    scope.requireRecentAuth();
    const result = await members.setManageMembers(db(), scope, params.userId, body.granted, now());
    if (!result.ok) return result.reason === 'not_found' ? notFound() : refuse(409, result.reason);
    return { userId: params.userId, manageMembers: body.granted };
  });

  registerRoute(app, removeMember, async ({ scope, params }) => {
    scope.requireRecentAuth();
    const result = await members.removeMember(db(), scope, params.userId, now());
    if (!result.ok) return notFound();
    return { removed: true as const };
  });

  registerRoute(app, setPublisher, async ({ scope, params, body }) => {
    scope.requireRecentAuth();
    const result = await members.setPublisher(db(), scope, params.userId, body.granted);
    if (!result.ok) return result.reason === 'not_found' ? notFound() : refuse(409, 'owner');
    return { userId: params.userId, publisher: body.granted };
  });

  // Brute-forcing codes is limited per session, not per address: a whole lecture hall may join
  // from one network address at once. Sessions come only from rate-limited sign-in links; a
  // cookie that does not verify shares its address's bucket. The key is the token's hash, as
  // stored in auth_sessions, so the limiter's store never holds a live session secret.
  const joinLimit = {
    rateLimit: {
      max: 20,
      timeWindow: '15 minutes',
      keyGenerator: (req: FastifyRequest) => {
        const token = readSessionToken(req);
        return token ? hashToken(token) : req.ip;
      },
    },
  };

  registerRoute(
    app,
    joinClass,
    async ({ scope, body }) => {
      const result = await invites.joinWithCode(db(), scope, body.code, now());
      if (!result.ok) return refuse(inviteStatus[result.reason], result.reason);
      return { ...result.joined, role: result.role };
    },
    joinLimit,
  );

  registerRoute(
    app,
    acceptInvitation,
    async ({ scope, body }) => {
      const result = await invites.acceptInstructorInvite(db(), scope, body.token, now());
      if (!result.ok) return refuse(inviteStatus[result.reason], result.reason);
      return { ...result.joined, role: result.role };
    },
    joinLimit,
  );
}
