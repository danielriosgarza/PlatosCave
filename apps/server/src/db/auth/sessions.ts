import { and, eq, gt, isNull } from 'drizzle-orm';
import { hashToken, newToken, type Principal, SESSION_TTL_MS } from '../../auth/sessions';
import type { Db } from '../client';
import { authSessions, users } from '../schema';

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
