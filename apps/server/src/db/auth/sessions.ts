import { and, eq, gt, isNull } from 'drizzle-orm';
import type { SignInResult } from '../../auth/identity-provider';
import { hashToken, newToken, type Principal, SESSION_TTL_MS } from '../../auth/sessions';
import type { Db, Executor } from '../client';
import { authSessions, users } from '../schema';
import { userForVerifiedEmail } from './accounts';

export async function createSession(
  db: Executor,
  userId: string,
  { now = new Date(), authTime = now }: { now?: Date; authTime?: Date } = {},
): Promise<{ token: string; sessionId: string }> {
  const token = newToken();
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

/**
 * Finishes a sign-in in one transaction: `consume` spends the proof, the account is found or
 * created, the session the browser held before (`previous`) is ended and a new one starts. A
 * failure at any step rolls the proof's use back, so the link still works on retry. Returns the
 * new session token, or just the destination to keep when the proof was not accepted.
 */
export function signInWithProof(
  db: Db,
  {
    consume,
    previous,
    now,
  }: { consume: (tx: Executor) => Promise<SignInResult>; previous?: string; now: Date },
): Promise<{ token?: string; destination: string | null }> {
  return db.transaction(async (tx) => {
    const result = await consume(tx);
    if (!result.ok) return { destination: result.destination };
    const userId = await userForVerifiedEmail(tx, result.email);
    // Rotation: whatever session this browser held before is ended, never upgraded in place.
    if (previous) await revokeSession(tx, previous, now);
    const { token } = await createSession(tx, userId, { now, authTime: now });
    return { token, destination: result.destination };
  });
}

/** Ends the session holding `token`, if it is still live. */
export async function revokeSession(db: Executor, token: string, now: Date): Promise<void> {
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
