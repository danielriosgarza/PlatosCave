import { exitPreview, startPreview } from '@parallax/contracts/routes/preview';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import {
  clearPreviewReturn,
  editorPath,
  readPreviewReturn,
  setPreviewReturn,
} from '../../auth/preview';
import { type ClassScope, resolveActorScope } from '../../auth/scope';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { topicOpens } from '../../content/availability';
import { findPrincipal, revokeSession } from '../../db/auth/sessions';
import { loadClassTopics } from '../../db/classTopics';
import type { Db } from '../../db/client';
import { PREVIEW_SESSION_TTL_MS, recordPreviewExit, startPreview as start } from '../../db/preview';
import { notFound, refuse, registerRoute } from '../register';

/**
 * Where a preview opens (§4), read as the preview student through its own class scope: the
 * topic's saved tab, else its first tab with material, else the class's topic list (also when
 * the topic is locked or empty for a student).
 */
async function landingOf(
  db: Db,
  previewUserId: string,
  classId: string,
  topicId: string | undefined,
  now: Date,
): Promise<string> {
  const list = `/classes/${classId}/topics`;
  if (!topicId) return list;
  const resolved = await resolveActorScope(
    db,
    previewUserId,
    { kind: 'class', role: 'any' },
    classId,
  );
  if (!resolved.ok || !resolved.scope) return list;
  const syllabus = await loadClassTopics(db, resolved.scope as ClassScope, now);
  const topic = syllabus.topics.find((t) => t.topicId === topicId);
  const tab = topic && topicOpens(topic.availability) ? (topic.savedTab ?? topic.firstTab) : null;
  return tab ? `${list}/${topicId}/${tab}` : list;
}

export default function previewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;
  const origin = config.APP_ORIGIN;
  const sessionCookie = sessionCookieOptions(origin);
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };

  registerRoute(app, startPreview, async ({ scope, body, req, reply }) => {
    const own = readSessionToken(req);
    // The resolver let a session through, so its token is present.
    if (!own) throw new Error('course scope resolved without a session token');
    const now = deps.now();
    // The preview session carries the authentication time of the session that started it.
    const principal = await findPrincipal(db(), own, now);
    if (!principal) throw app.httpErrors.unauthorized();
    const started = await start(db(), scope, { ...body, authTime: principal.authTime }, now);
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
      preview: { id: started.previewUserId, name: started.name },
      expiresAt: new Date(now.getTime() + PREVIEW_SESSION_TTL_MS).toISOString(),
      landing: await landingOf(db(), started.previewUserId, started.classId, body.topicId, now),
    };
  });

  /**
   * Public, so it works after the preview session ended (expiry, a later start): it resolves
   * both cookies itself. Only a live instructor session that owns the preview (or any live
   * instructor session, once the preview session is gone) is handed back; everything else the
   * browser holds is revoked.
   */
  registerRoute(app, exitPreview, async ({ req, reply }) => {
    const now = deps.now();
    const token = readSessionToken(req);
    const current = token ? await findPrincipal(db(), token, now) : null;
    const kept = readPreviewReturn(req);
    if (current?.kind === 'user' || (!current && !kept)) return refuse(409, 'not_previewing');
    const owner = kept ? await findPrincipal(db(), kept.token, now) : null;
    const restored =
      owner?.kind === 'user' && (!current || current.ownerUserId === owner.id) && kept;
    if (current?.kind === 'preview' && current.ownerUserId) {
      await recordPreviewExit(db(), {
        previewUserId: current.id,
        instructorId: current.ownerUserId,
      });
    }
    if (token) await revokeSession(db(), token, now);
    if (kept && !restored) await revokeSession(db(), kept.token, now);
    if (restored) reply.setCookie(SESSION_COOKIE, restored.token, sessionCookie);
    else reply.clearCookie(SESSION_COOKIE, sessionCookie);
    clearPreviewReturn(req, reply, origin);
    return {
      restored: Boolean(restored),
      returnTo: kept ? editorPath(kept) : '/courses',
    };
  });
}
