import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { authSessions, users } from '../db/schema';

export const SESSION_COOKIE = 'pc_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;

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
  { now = new Date(), authTime = now }: { now?: Date; authTime?: Date } = {},
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(authSessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      authTime,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    })
    .returning({ id: authSessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, sessionId: row.id };
}

/** Reads the session cookie from a raw Cookie header (P1-02 replaces this with @fastify/cookie). */
export function sessionTokenFrom(cookieHeader: string | undefined): string | undefined {
  for (const part of cookieHeader?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

export async function findPrincipal(db: Db, token: string, now: Date): Promise<Principal | null> {
  const [row] = await db
    .select({
      id: users.id,
      kind: users.kind,
      name: users.name,
      email: users.email,
      ownerUserId: users.ownerUserId,
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
