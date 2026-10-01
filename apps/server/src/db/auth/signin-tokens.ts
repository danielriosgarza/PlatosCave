import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { signinTokens } from '../schema';

/** Deletes links that expired before `cutoff`, used or not; returns how many went. */
export async function deleteSigninTokensExpiredBefore(db: Db, cutoff: Date): Promise<number> {
  const result = await db.delete(signinTokens).where(lt(signinTokens.expiresAt, cutoff));
  return result.rowCount ?? 0;
}

export interface NewSigninToken {
  email: string;
  tokenHash: string;
  destination: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Stores a link unless its address already has `limit` links created after `since`; returns
 * the new row's id, or undefined when the cap is reached. Count and insert run under a
 * per-address lock, so concurrent requests cannot all pass the cap.
 */
export function insertSigninTokenUnderCap(
  db: Db,
  token: NewSigninToken,
  { since, limit }: { since: Date; limit: number },
): Promise<{ id: string } | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signin:${token.email}`}))`);
    const [recent] = await tx
      .select({ n: count() })
      .from(signinTokens)
      .where(and(eq(signinTokens.email, token.email), gt(signinTokens.createdAt, since)));
    if ((recent?.n ?? 0) >= limit) return undefined;
    const [inserted] = await tx
      .insert(signinTokens)
      .values(token)
      .returning({ id: signinTokens.id });
    return inserted;
  });
}

export async function deleteSigninToken(db: Db, id: string): Promise<void> {
  await db.delete(signinTokens).where(eq(signinTokens.id, id));
}

/**
 * Marks the unused, unexpired link with this hash used and returns it. One conditional update:
 * of two concurrent uses, exactly one gets the row back.
 */
export async function useSigninToken(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<{ email: string; destination: string | null } | undefined> {
  const [used] = await db
    .update(signinTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(signinTokens.tokenHash, tokenHash),
        isNull(signinTokens.usedAt),
        gt(signinTokens.expiresAt, now),
      ),
    )
    .returning({ email: signinTokens.email, destination: signinTokens.destination });
  return used;
}

/** The destination of a stored link, used or expired; null when no link has this hash. */
export async function findSigninDestination(db: Db, tokenHash: string): Promise<string | null> {
  const [known] = await db
    .select({ destination: signinTokens.destination })
    .from(signinTokens)
    .where(eq(signinTokens.tokenHash, tokenHash));
  return known?.destination ?? null;
}
