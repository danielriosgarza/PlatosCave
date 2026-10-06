import {
  archiveClass,
  archiveCourse,
  deactivateAccount,
  deleteAccount,
  exportAnnotations,
  restoreClass,
  restoreCourse,
} from '@parallax/contracts/routes/lifecycle';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import type { UserScope } from '../../auth/scope';
import * as lifecycle from '../../db/lifecycle';
import { revokeUserConnectors } from '../../relay/links';
import { registerRoute } from '../register';

export default function lifecycleRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { now, links } = deps;
  const db = deps.requireDb;

  registerRoute(app, archiveClass, async ({ scope, fail }) => {
    const result = await lifecycle.archiveClass(db(), scope, now());
    if (!result.ok) return fail(409, { error: 'class_archived' });
    return { id: result.id, archived: true };
  });

  registerRoute(app, restoreClass, async ({ scope, fail }) => {
    const result = await lifecycle.restoreClass(db(), scope, now());
    if (result.ok) return { id: result.id, archived: false };
    return result.reason === 'course_archived'
      ? fail(409, { error: 'course_archived' })
      : fail(409, { error: 'not_archived' });
  });

  registerRoute(app, archiveCourse, async ({ scope, fail }) => {
    const result = await lifecycle.archiveCourse(db(), scope, now());
    if (!result.ok) return fail(409, { error: 'course_archived' });
    return { id: result.id, archived: true };
  });

  registerRoute(app, restoreCourse, async ({ scope, fail }) => {
    const result = await lifecycle.restoreCourse(db(), scope);
    if (!result.ok) return fail(409, { error: 'not_archived' });
    return { id: result.id, archived: false };
  });

  registerRoute(app, exportAnnotations, ({ scope }) =>
    lifecycle.exportOwnAnnotations(db(), scope, now()),
  );

  /** §13: closing an account is a person's own decision, after a recent sign-in; never a preview's. */
  async function close(
    scope: UserScope,
    mode: 'deactivate' | 'delete',
    fail: (status: 403 | 409, body: { error: 'forbidden' } | { error: 'owns_courses' }) => never,
  ) {
    scope.requireRecentAuth();
    if (scope.user.kind === 'preview') return fail(403, { error: 'forbidden' });
    const at = now();
    const result = await lifecycle.closeAccount(db(), scope, mode, at);
    if (!result.ok) return fail(409, { error: 'owns_courses' });
    // The person's connectors die with the account and their live links close (§10.6).
    for (const id of result.userIds) await revokeUserConnectors(db(), links, id, at);
    return { deactivatedAt: result.deactivatedAt.toISOString() };
  }

  registerRoute(app, deactivateAccount, ({ scope, fail }) => close(scope, 'deactivate', fail));
  registerRoute(app, deleteAccount, ({ scope, fail }) => close(scope, 'delete', fail));
}
