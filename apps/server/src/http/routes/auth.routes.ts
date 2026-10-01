import { requestSignInLink, signOut, verifySignInLink } from '@parallax/contracts/routes/auth';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { userForVerifiedEmail } from '../../auth/accounts';
import { defaultDestination, safeDestination } from '../../auth/destination';
import { EmailLinkProvider } from '../../auth/email-provider';
import {
  createSession,
  readSessionToken,
  revokeSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../../auth/sessions';
import { registerRoute } from '../register';

const EXPIRED = '/signin?link=expired';

export default function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, mailer } = app.authDeps;
  const now = () => app.resolverDeps.now();
  const cookieOptions = sessionCookieOptions(config.APP_ORIGIN);
  const provider = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return new EmailLinkProvider({
      db: deps.db,
      mailer,
      now,
      appOrigin: config.APP_ORIGIN,
      log: app.log,
    });
  };

  registerRoute(
    app,
    requestSignInLink,
    async ({ body }) => {
      const destination = safeDestination(body.next) ?? defaultDestination(body.entrance);
      await provider().begin({ email: body.email, destination });
      return { accepted: true as const };
    },
    { rateLimit: { max: config.AUTH_LINK_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(app, verifySignInLink, async ({ query, req, reply }) => {
    const db = deps.db;
    if (!db) throw app.httpErrors.serviceUnavailable();
    const result = query.token ? await provider().complete(query.token) : null;
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
    const { token } = await createSession(db, userId, { now: at, authTime: at });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    // Re-checked at use: a stored destination is only ever a same-origin app path.
    return reply.redirect(safeDestination(result.destination) ?? '/courses') as never;
  });

  registerRoute(app, signOut, async ({ req, reply }) => {
    const token = readSessionToken(req);
    if (token && deps.db) await revokeSession(deps.db, token, now());
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined });
    return { signedOut: true as const };
  });
}
