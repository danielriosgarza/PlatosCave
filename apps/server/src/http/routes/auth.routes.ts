import { requestSignInLink, signOut, verifySignInLink } from '@parallax/contracts/routes/auth';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { defaultDestination, safeDestination } from '../../auth/destination';
import { EmailLinkProvider } from '../../auth/email-provider';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { revokeSession, signInWithProof } from '../../db/auth/sessions';
import { registerRoute } from '../register';

const EXPIRED = '/signin?link=expired';

export default function authRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, mailer, background } = deps;
  const now = () => app.resolverDeps.now();
  const cookieOptions = sessionCookieOptions(config.APP_ORIGIN);
  const { db } = deps;
  const provider = db
    ? new EmailLinkProvider({
        db,
        mailer,
        now,
        background,
        appOrigin: config.APP_ORIGIN,
        log: app.log,
      })
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
      // Spending the link, finding the account, ending the old session and starting the new one
      // are one transaction: a failure after the link is marked used rolls the use back, so the
      // link still works on retry instead of leaving a dead link and a 500.
      const signedIn = await signInWithProof(db, {
        consume: (tx) =>
          query.token
            ? provider.complete(query.token, tx)
            : Promise.resolve({ ok: false as const, destination: null }),
        previous: readSessionToken(req),
        now: now(),
      });
      if (!signedIn.token) {
        const keep = safeDestination(signedIn.destination);
        const to = keep ? `${EXPIRED}&next=${encodeURIComponent(keep)}` : EXPIRED;
        return reply.redirect(to) as never;
      }
      reply.setCookie(SESSION_COOKIE, signedIn.token, cookieOptions);
      // Re-checked at use: a stored destination is only ever a same-origin app path.
      return reply.redirect(safeDestination(signedIn.destination) ?? '/courses') as never;
    },
    { rateLimit: { max: config.AUTH_VERIFY_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(app, signOut, async ({ req, reply }) => {
    // Only a request carrying a validly signed session cookie ends anything or clears the
    // cookie. The route is public and Fastify parses text/plain, so a cross-site form post
    // reaches it without the (SameSite=Lax) cookie; answering Set-Cookie there would sign the
    // visitor out of their own session.
    const token = readSessionToken(req);
    if (token) {
      if (db) await revokeSession(db, token, now());
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
    }
    return { signedOut: true as const };
  });
}
