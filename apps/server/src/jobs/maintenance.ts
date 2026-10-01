import { lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { LINK_TTL_MS } from '../auth/email-provider';
import type { Db } from '../db/client';
import { signinTokens } from '../db/schema';

/** Sign-in links stay this long after expiry, then go (§3: nothing reads them after expiry). */
export const SIGNIN_TOKEN_RETENTION_MS = 24 * 3_600_000;

export const PURGE_SIGNIN_TOKENS = 'maintenance.purge-signin-tokens';
/** Hourly, at minute 17. */
export const PURGE_SIGNIN_TOKENS_CRON = '17 * * * *';

/**
 * Deletes sign-in links that expired more than a day ago, used or not. Live and recently
 * expired links stay, so the per-address cap and the "link expired" answer keep working.
 * Filters on `created_at` (`expires_at` is always `created_at + LINK_TTL_MS`), so the
 * `(email, created_at)` index serves this and the per-address cap alike.
 */
export async function purgeSigninTokens(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - LINK_TTL_MS - SIGNIN_TOKEN_RETENTION_MS);
  const result = await db.delete(signinTokens).where(lt(signinTokens.createdAt, cutoff));
  return result.rowCount ?? 0;
}

export interface MaintenanceLogger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Maintenance jobs act on no class or course, so they sit outside the scoped-job wrapper
 * (ADR-0002): they take no payload and are only ever started by the schedule below.
 */
export async function workMaintenance(boss: PgBoss, db: Db, log: MaintenanceLogger) {
  await boss.createQueue(PURGE_SIGNIN_TOKENS);
  await boss.schedule(PURGE_SIGNIN_TOKENS, PURGE_SIGNIN_TOKENS_CRON);
  await boss.work(PURGE_SIGNIN_TOKENS, async () => {
    try {
      const purged = await purgeSigninTokens(db, new Date());
      log.info({ job: PURGE_SIGNIN_TOKENS, purged }, 'purged expired sign-in links');
      return { purged };
    } catch (err) {
      // pg-boss records the failure and retries but never reaches its `error` listener.
      log.error({ err, job: PURGE_SIGNIN_TOKENS }, 'purging sign-in links failed');
      throw err;
    }
  });
  log.info({ job: PURGE_SIGNIN_TOKENS, cron: PURGE_SIGNIN_TOKENS_CRON }, 'maintenance scheduled');
}
