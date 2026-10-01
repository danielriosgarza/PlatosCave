import type { PgBoss } from 'pg-boss';
import { purgeSigninTokens } from '../auth/email-provider';
import type { Db } from '../db/client';

export const PURGE_SIGNIN_TOKENS = 'maintenance.purge-signin-tokens';
/** Hourly, at minute 17. */
export const PURGE_SIGNIN_TOKENS_CRON = '17 * * * *';

export interface MaintenanceLogger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Maintenance jobs act on no class or course, so they sit outside the scoped-job wrapper
 * (ADR-0002): they take no payload and are only ever started by the schedule below.
 */
/** Registers every maintenance queue and returns their names. */
export async function workMaintenance(
  boss: PgBoss,
  db: Db,
  log: MaintenanceLogger,
): Promise<string[]> {
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
  return [PURGE_SIGNIN_TOKENS];
}
