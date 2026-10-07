import { type CookieSerializeOptions, sign } from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'pc_session';

/**
 * The session token from the signed `pc_session` cookie (SESSION_SECRET signs it via
 * @fastify/cookie), or undefined when absent or tampered with.
 */
export function readSessionToken(req: FastifyRequest): string | undefined {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

/** HttpOnly, SameSite=Lax, signed; Secure whenever the app is served over https. */
export function sessionCookieOptions(appOrigin: string, ttlMs: number): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: appOrigin.startsWith('https:'),
    signed: true,
    maxAge: ttlMs / 1000,
  };
}

/** A Cookie request header carrying `token`, as a browser would send it (fixtures and tests). */
export const sessionCookieHeader = (token: string, secret: string): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(sign(token, secret))}`;
