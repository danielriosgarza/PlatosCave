import { requestSignInLink, signOut, verifySignInLink } from '@parallax/contracts/routes/auth';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { defaultDestination, safeDestination } from '../../auth/destination';
import { EmailLinkProvider } from '../../auth/email-provider';
import { clearPreviewReturn, PREVIEW_RETURN_COOKIE, revokePreviewReturn } from '../../auth/preview';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { TOKEN_SHAPE } from '../../auth/tokens';
import { revokeSession, signInWithProof } from '../../db/auth/sessions';
import { registerRoute } from '../register';

const EXPIRED = '/signin?link=expired';

export default function authRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, mailer, background } = deps;
  const { now } = deps;
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
      // A missing or malformed token is decided in memory: no transaction, no pool connection.
      const { token } = query;
      if (!token || !TOKEN_SHAPE.test(token)) return reply.redirect(EXPIRED) as never;
      // Spending the link, finding the account, ending the old session and starting the new one
      // are one transaction: a failure after the link is marked used rolls the use back, so the
      // link still works on retry instead of leaving a dead link and a 500.
      const at = now();
      const signedIn = await signInWithProof(db, {
        consume: (tx) => provider.complete(token, tx),
        previous: readSessionToken(req),
        // A kept instructor session (a preview in progress) ends with the sign-in or not at all.
        alsoEnd: (tx) => revokePreviewReturn(tx, req, at),
        now: at,
      });
      if (!signedIn.token) {
        const keep = safeDestination(signedIn.destination);
        const to = keep ? `${EXPIRED}&next=${encodeURIComponent(keep)}` : EXPIRED;
        return reply.redirect(to) as never;
      }
      reply.setCookie(SESSION_COOKIE, signedIn.token, cookieOptions);
      clearPreviewReturn(req, reply, config.APP_ORIGIN);
      // Re-checked at use: a stored destination is only ever a same-origin app path.
      return reply.redirect(safeDestination(signedIn.destination) ?? '/courses') as never;
    },
    { rateLimit: { max: config.AUTH_VERIFY_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(app, signOut, async ({ req, reply }) => {
    // Only a request that carries one of our cookies ends or clears anything. The route is public
    // and Fastify parses text/plain, so a cross-site form post reaches it without the
    // (SameSite=Lax) cookies; answering Set-Cookie there would sign the visitor out of their own
    // session. Presence is enough (not a valid signature), so a cookie the server can no longer
    // unsign, such as after a SESSION_SECRET rotation, is still dropped. A browser can hold either
    // cookie alone: the preview session's cookie lives 8 h, the preview-return cookie 14 d.
    const hasSession = req.cookies?.[SESSION_COOKIE] !== undefined;
    const hasReturn = req.cookies?.[PREVIEW_RETURN_COOKIE] !== undefined;
    if (!hasSession && !hasReturn) return { signedOut: true as const };
    const at = now();
    if (hasSession) {
      const token = readSessionToken(req);
      if (token && db) await revokeSession(db, token, at);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
    }
    await revokePreviewReturn(db, req, at);
    clearPreviewReturn(req, reply, config.APP_ORIGIN);
    return { signedOut: true as const };
  });
}
