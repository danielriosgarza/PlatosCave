import { and, count, eq, gt, isNull, lt, max, sql } from 'drizzle-orm';
import type { Db, Executor } from '../client';
import { signinTokens } from '../schema';

/** Deletes links that expired before `cutoff`, used or not; returns how many went. */
export async function deleteSigninTokensExpiredBefore(db: Db, cutoff: Date): Promise<number> {
  const result = await db.delete(signinTokens).where(lt(signinTokens.expiresAt, cutoff));
  return result.rowCount ?? 0;
}

export type NewSigninToken = Pick<
  typeof signinTokens.$inferInsert,
  'email' | 'tokenHash' | 'destination' | 'createdAt' | 'expiresAt'
>;

/**
 * Stores a link unless the cap holds; returns the new row's id, or undefined when it does. The
 * cap holds while the address has `limit` unused links created after `since` and its newest
 * link was created after `floorSince`; once the newest is older than that, one more link is
 * stored whatever the count. Count and insert run under a per-address lock, so concurrent
 * requests cannot all pass the cap. The address is lowercased here, for the lock, the count
 * and the stored row alike.
 */
export function insertSigninTokenUnderCap(
  db: Db,
  token: NewSigninToken,
  { since, limit, floorSince }: { since: Date; limit: number; floorSince: Date },
): Promise<{ id: string } | undefined> {
  const email = token.email.toLowerCase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signin:${email}`}))`);
    const [recent] = await tx
      .select({
        unused: count(sql`case when ${signinTokens.usedAt} is null then 1 end`),
        newest: max(signinTokens.createdAt),
      })
      .from(signinTokens)
      .where(and(eq(signinTokens.email, email), gt(signinTokens.createdAt, since)));
    const capped = (recent?.unused ?? 0) >= limit;
    const floorOpen = !recent?.newest || recent.newest <= floorSince;
    if (capped && !floorOpen) return undefined;
    const [inserted] = await tx
      .insert(signinTokens)
      .values({ ...token, email })
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
  db: Executor,
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
export async function findSigninDestination(
  db: Executor,
  tokenHash: string,
): Promise<string | null> {
  const [known] = await db
    .select({ destination: signinTokens.destination })
    .from(signinTokens)
    .where(eq(signinTokens.tokenHash, tokenHash));
  return known?.destination ?? null;
}
