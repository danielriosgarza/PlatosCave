import { exitPreview, startPreview } from '@parallax/contracts/routes/preview';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import {
  editorPath,
  PREVIEW_RETURN_COOKIE,
  readPreviewReturn,
  returnCookieOptions,
  setPreviewReturn,
} from '../../auth/preview';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { findPrincipal, revokeSession } from '../../db/auth/sessions';
import { PREVIEW_SESSION_TTL_MS, startPreview as start } from '../../db/preview';
import { notFound, refuse, registerRoute } from '../register';

export default function previewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;
  const origin = config.APP_ORIGIN;
  const sessionCookie = sessionCookieOptions(origin);
  const db = () => {
    const { db } = app.resolverDeps;
    if (!db) throw app.httpErrors.serviceUnavailable();
    return db;
  };

  registerRoute(app, startPreview, async ({ scope, body, req, reply }) => {
    const own = readSessionToken(req);
    // The resolver let a session through, so its token is present.
    if (!own) throw new Error('course scope resolved without a session token');
    const now = app.resolverDeps.now();
    const started = await start(db(), scope, body, now);
    if (!started.ok) return notFound();
    setPreviewReturn(
      reply,
      { token: own, courseId: scope.courseId, topicId: body.topicId },
      origin,
    );
    reply.setCookie(SESSION_COOKIE, started.token, {
      ...sessionCookie,
      maxAge: PREVIEW_SESSION_TTL_MS / 1000,
    });
    return {
      classId: started.classId,
      preview: { id: started.previewUserId, name: 'Preview student' },
      expiresAt: new Date(now.getTime() + PREVIEW_SESSION_TTL_MS).toISOString(),
    };
  });

  registerRoute(app, exitPreview, async ({ scope, req, reply }) => {
    const { user } = scope;
    if (user.kind !== 'preview') return refuse(409, 'not_previewing');
    const now = app.resolverDeps.now();
    const kept = readPreviewReturn(req);
    const owner = kept && (await findPrincipal(db(), kept.token, now));
    // Only the instructor who owns this preview gets their session back.
    const restored = Boolean(owner && owner.id === user.ownerUserId && owner.kind === 'user');
    const token = readSessionToken(req);
    if (token) await revokeSession(db(), token, now);
    if (restored && kept) reply.setCookie(SESSION_COOKIE, kept.token, sessionCookie);
    else reply.clearCookie(SESSION_COOKIE, sessionCookie);
    if (req.cookies?.[PREVIEW_RETURN_COOKIE]) {
      reply.clearCookie(PREVIEW_RETURN_COOKIE, returnCookieOptions(origin));
    }
    return { restored, returnTo: kept ? editorPath(kept) : '/courses' };
  });
}
