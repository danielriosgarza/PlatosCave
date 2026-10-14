import {
  finishProviderSignIn,
  listSignInMethods,
  requestSignInLink,
  signOut,
  startProviderSignIn,
  verifySignInLink,
} from '@parallax/contracts/routes/auth';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from '../../app';
import { defaultDestination, safeDestination } from '../../auth/destination';
import { EmailLinkProvider } from '../../auth/email-provider';
import { OidcProvider, PendingSignIn } from '../../auth/oidc-provider';
import { clearPreviewReturn, PREVIEW_RETURN_COOKIE, revokePreviewReturn } from '../../auth/preview';
import { readSessionToken, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { TOKEN_SHAPE } from '../../auth/tokens';
import { revokeSession, signInWithProof } from '../../db/auth/sessions';
import { notFound, registerRoute } from '../register';

const EXPIRED = '/signin?link=expired';
/** A provider sign-in waiting for the issuer, kept by the browser ten minutes at most. */
const PENDING_COOKIE = 'pc_oidc';
const PENDING_MS = 10 * 60_000;

/** The sign-in page explaining a refused provider sign-in, keeping a same-origin `next`. */
function refusedAt(id: string, reason: 'unverified' | 'failed', destination?: string | null) {
  const search = new URLSearchParams({ provider: id, refused: reason });
  const keep = safeDestination(destination);
  if (keep) search.set('next', keep);
  return `/signin?${search}`;
}

/** This browser's pending sign-in, or undefined when absent, forged, malformed or too old. */
function readPending(req: FastifyRequest, at: Date): PendingSignIn | undefined {
  const raw = req.cookies?.[PENDING_COOKIE];
  const unsigned = raw ? req.unsignCookie(raw) : undefined;
  if (!unsigned?.valid || !unsigned.value) return undefined;
  try {
    const value = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8'));
    const pending = PendingSignIn.parse(value);
    return at.getTime() - pending.startedAt <= PENDING_MS ? pending : undefined;
  } catch {
    return undefined;
  }
}

export default function authRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, mailer, background } = deps;
  const { now } = deps;
  const sessionTtlMs = config.SESSION_TTL_MS;
  const cookieOptions = sessionCookieOptions(config.APP_ORIGIN, sessionTtlMs);
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
  const callbackOf = (id: string) => new URL(`/api/auth/oidc/${id}/callback`, config.APP_ORIGIN);
  const oidc = { fetch: deps.identityFetch, now, log: app.log };
  const providers = new Map(
    config.OIDC_PROVIDERS.map((settings) => {
      const redirectUri = callbackOf(settings.id);
      return [settings.id, new OidcProvider({ ...oidc, settings, redirectUri })];
    }),
  );
  // Sent only to the provider routes; HttpOnly, SameSite=Lax, signed and Secure like the session.
  const pendingOptions = {
    ...sessionCookieOptions(config.APP_ORIGIN, PENDING_MS),
    path: '/api/auth/oidc',
  };

  registerRoute(
    app,
    requestSignInLink,
    async ({ body }) => {
      if (!provider || config.MAIL_TRANSPORT === 'none') throw app.httpErrors.serviceUnavailable();
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
        ttlMs: sessionTtlMs,
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

  registerRoute(app, listSignInMethods, () => ({
    email: config.MAIL_TRANSPORT !== 'none',
    providers: config.OIDC_PROVIDERS.map(({ id, name }) => ({ id, name })),
  }));

  registerRoute(
    app,
    startProviderSignIn,
    async ({ params, query, reply }) => {
      const provider = providers.get(params.provider) ?? notFound();
      const next = safeDestination(query.next);
      const destination = next ?? defaultDestination(query.entrance);
      const started = await provider.begin({ destination }).catch(() => undefined);
      // Discovery failed (the issuer cannot be reached or answers wrongly); nothing is kept.
      if (!started) return reply.redirect(refusedAt(provider.id, 'failed', next)) as never;
      const record = Buffer.from(JSON.stringify(started.pending)).toString('base64url');
      reply.setCookie(PENDING_COOKIE, record, pendingOptions);
      return reply.redirect(started.url.href) as never;
    },
    { rateLimit: { max: config.AUTH_LINK_RATE_LIMIT, timeWindow: '15 minutes' } },
  );

  registerRoute(
    app,
    finishProviderSignIn,
    async ({ params, query, req, reply }) => {
      const provider = providers.get(params.provider) ?? notFound();
      if (!db) throw app.httpErrors.serviceUnavailable();
      const backToSignIn = (reason: 'unverified' | 'failed', destination?: string | null) =>
        reply.redirect(refusedAt(provider.id, reason, destination)) as never;
      const at = now();
      const pending = readPending(req, at);
      reply.clearCookie(PENDING_COOKIE, pendingOptions);
      // A browser that did not start this sign-in (login CSRF), or a forged or old record.
      if (!pending) return backToSignIn('failed');
      const callback = callbackOf(provider.id);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) callback.searchParams.set(key, value);
      }
      // The issuer is asked outside any transaction, so no pool connection waits for it.
      const result = await provider.complete({ callback, pending });
      if (!result.ok) return backToSignIn(result.reason ?? 'failed', result.destination);
      const signedIn = await signInWithProof(db, {
        consume: async () => result,
        previous: readSessionToken(req),
        alsoEnd: (tx) => revokePreviewReturn(tx, req, at),
        now: at,
        ttlMs: sessionTtlMs,
      });
      // A deactivated account answers like a sign-in that did not finish.
      if (!signedIn.token) return backToSignIn('failed', signedIn.destination);
      reply.setCookie(SESSION_COOKIE, signedIn.token, cookieOptions);
      clearPreviewReturn(req, reply, config.APP_ORIGIN);
      return reply.redirect(safeDestination(signedIn.destination) ?? '/courses') as never;
    },
    { rateLimit: { max: config.AUTH_VERIFY_RATE_LIMIT, timeWindow: '15 minutes' } },
  );
}
