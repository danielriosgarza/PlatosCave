import { requestSignInLink, signOut, verifySignInLink } from '@parallax/contracts/routes/auth';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { defaultDestination, safeDestination } from '../../auth/destination';
import { EmailLinkProvider } from '../../auth/email-provider';
import { endPreviewReturn } from '../../auth/preview';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { userForVerifiedEmail } from '../../db/auth/accounts';
import { createSession, revokeSession } from '../../db/auth/sessions';
import { registerRoute } from '../register';

const EXPIRED = '/signin?link=expired';

export default function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, mailer } = app.authDeps;
  const now = () => app.resolverDeps.now();
  const cookieOptions = sessionCookieOptions(config.APP_ORIGIN);
  const { db } = deps;
  const provider = db
    ? new EmailLinkProvider({ db, mailer, now, appOrigin: config.APP_ORIGIN, log: app.log })
    : undefined;

  registerRoute(
    app,
    requestSignInLink,
    async ({ body }) => {
      if (!provider) throw app.httpErrors.serviceUnavailable();
      const destination = safeDestination(body.next) ?? defaultDestination(body.entrance);
      await provider.begin({ email: body.email, destination });
      return { accepted: true as const };
    },
    { rateLimit: { max: config.AUTH_LINK_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(
    app,
    verifySignInLink,
    async ({ query, req, reply }) => {
      if (!db || !provider) throw app.httpErrors.serviceUnavailable();
      const result = query.token ? await provider.complete(query.token) : null;
      if (!result?.ok) {
        const keep = safeDestination(result?.destination);
        const to = keep ? `${EXPIRED}&next=${encodeURIComponent(keep)}` : EXPIRED;
        return reply.redirect(to) as never;
      }
      const userId = await userForVerifiedEmail(db, result.email);
      const at = now();
      // Rotation: whatever session this browser held before is ended, never upgraded in place.
      const previous = readSessionToken(req);
      if (previous) await revokeSession(db, previous, at);
      await endPreviewReturn(db, req, reply, config.APP_ORIGIN, at);
      const { token } = await createSession(db, userId, { now: at, authTime: at });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      // Re-checked at use: a stored destination is only ever a same-origin app path.
      return reply.redirect(safeDestination(result.destination) ?? '/courses') as never;
    },
    { rateLimit: { max: config.AUTH_VERIFY_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(app, signOut, async ({ req, reply }) => {
    const token = readSessionToken(req);
    if (token && db) await revokeSession(db, token, now());
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    await endPreviewReturn(db, req, reply, config.APP_ORIGIN, now());
    return { signedOut: true as const };
  });
}
