import { createHash, randomBytes } from 'node:crypto';
import { type CookieSerializeOptions, sign } from '@fastify/cookie';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { authSessions, users } from '../db/schema';

export const SESSION_COOKIE = 'pc_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;

/** A fresh secret token: 32 random bytes in base64url (43 characters). */
export const newToken = (): string => randomBytes(32).toString('base64url');
/** The shape every token from `newToken` has. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Tokens are stored only as their SHA-256, so a database read cannot be replayed as a cookie. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** A person who can act: a signed-in session's user, or the actor of a background job. */
export interface Actor {
  id: string;
  kind: 'user' | 'preview';
  name: string;
  email: string | null;
  ownerUserId: string | null;
}

export interface Principal extends Actor {
  sessionId: string;
  authTime: Date;
}

export async function createSession(
  db: Db,
  userId: string,
  {
    now = new Date(),
    authTime = now,
    ttlMs = SESSION_TTL_MS,
  }: { now?: Date; authTime?: Date; ttlMs?: number } = {},
): Promise<{ token: string; sessionId: string }> {
  const token = newToken();
  const [row] = await db
    .insert(authSessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      authTime,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    })
    .returning({ id: authSessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, sessionId: row.id };
}

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
export function sessionCookieOptions(appOrigin: string): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: appOrigin.startsWith('https:'),
    signed: true,
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/** A Cookie request header carrying `token`, as a browser would send it (fixtures and tests). */
export const sessionCookieHeader = (token: string, secret: string): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(sign(token, secret))}`;

/** Ends the session holding `token`, if it is still live. */
export async function revokeSession(db: Db, token: string, now: Date): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.tokenHash, hashToken(token)), isNull(authSessions.revokedAt)));
}

/** The columns that make an `Actor`, for every query that loads one (sessions and jobs). */
export const actorColumns = {
  id: users.id,
  kind: users.kind,
  name: users.name,
  email: users.email,
  ownerUserId: users.ownerUserId,
};

export async function findPrincipal(db: Db, token: string, now: Date): Promise<Principal | null> {
  const [row] = await db
    .select({
      ...actorColumns,
      sessionId: authSessions.id,
      authTime: authSessions.authTime,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    );
  return row ?? null;
}
