import { lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '../db/client';
import { signinTokens } from '../db/schema';
import type { WorkLogger } from './scoped';

/** Sign-in links stay this long after expiry, then go (§3: nothing reads them after expiry). */
export const SIGNIN_TOKEN_RETENTION_MS = 24 * 3_600_000;

export const PURGE_SIGNIN_TOKENS = 'maintenance.purge-signin-tokens';
/** Hourly, at minute 17. */
export const PURGE_SIGNIN_TOKENS_CRON = '17 * * * *';

/**
 * Deletes sign-in links that expired more than a day ago, used or not. Live and recently
 * expired links stay, so the per-address cap and the "link expired" answer keep working.
 */
export async function purgeSigninTokens(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(signinTokens)
    .where(lt(signinTokens.expiresAt, new Date(now.getTime() - SIGNIN_TOKEN_RETENTION_MS)))
    .returning({ id: signinTokens.id });
  return rows.length;
}

/**
 * Maintenance jobs act on no class or course, so they sit outside the scoped-job wrapper
 * (ADR-0002): they take no payload and are only ever started by the schedule below.
 */
export async function workMaintenance(
  boss: PgBoss,
  db: Db,
  log: WorkLogger & { info: (obj: object, msg: string) => void },
) {
  await boss.createQueue(PURGE_SIGNIN_TOKENS);
  await boss.schedule(PURGE_SIGNIN_TOKENS, PURGE_SIGNIN_TOKENS_CRON);
  await boss.work(PURGE_SIGNIN_TOKENS, async () => {
    const purged = await purgeSigninTokens(db, new Date());
    log.info({ job: PURGE_SIGNIN_TOKENS, purged }, 'purged expired sign-in links');
    return { purged };
  });
}
