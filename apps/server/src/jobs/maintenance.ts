import type { PgBoss } from 'pg-boss';
import { purgeSigninTokens } from '../auth/email-provider';
import type { Db } from '../db/client';
import { purgePairings } from '../db/connectors/pairing';
import { expirePendingConnectors } from '../db/connectors/registry';
import type { JobLogger } from './logger';

export const PURGE_SIGNIN_TOKENS = 'maintenance.purge-signin-tokens';
/** Hourly, at minute 17. */
export const PURGE_SIGNIN_TOKENS_CRON = '17 * * * *';

export const PURGE_CONNECTOR_PAIRINGS = 'maintenance.purge-connector-pairings';
/** Hourly, at minute 23. */
export const PURGE_CONNECTOR_PAIRINGS_CRON = '23 * * * *';

/**
 * Used and expired pairing codes are deleted, and pending connectors past their approval
 * window are revoked as `expired` (docs/design/connector.md §3); reads expire them too.
 */
export async function purgeConnectorPairings(db: Db, now: Date) {
  const purged = await purgePairings(db, now);
  const expired = (await expirePendingConnectors(db, now)).length;
  return { purged, expired };
}

const maintenance: { name: string; cron: string; run: (db: Db, now: Date) => Promise<object> }[] = [
  {
    name: PURGE_SIGNIN_TOKENS,
    cron: PURGE_SIGNIN_TOKENS_CRON,
    run: async (db, now) => ({ purged: await purgeSigninTokens(db, now) }),
  },
  {
    name: PURGE_CONNECTOR_PAIRINGS,
    cron: PURGE_CONNECTOR_PAIRINGS_CRON,
    run: purgeConnectorPairings,
  },
];

/**
 * Registers every maintenance queue and returns their names. Maintenance jobs act on no class
 * or course, so they sit outside the scoped-job wrapper (ADR-0002): they take no payload and
 * are only ever started by the schedule below.
 */
export async function workMaintenance(boss: PgBoss, db: Db, log: JobLogger): Promise<string[]> {
  for (const { name, cron, run } of maintenance) {
    await boss.createQueue(name);
    await boss.schedule(name, cron);
    await boss.work(name, async () => {
      try {
        const result = await run(db, new Date());
        log.info({ job: name, ...result }, 'maintenance done');
        return result;
      } catch (err) {
        // pg-boss records the failure and retries but never reaches its `error` listener.
        log.error({ err, job: name }, 'maintenance failed');
        throw err;
      }
    });
    log.info({ job: name, cron }, 'maintenance scheduled');
  }
  return maintenance.map((m) => m.name);
}
