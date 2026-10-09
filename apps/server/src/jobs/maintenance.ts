import type { PgBoss } from 'pg-boss';
import { purgeSigninTokens } from '../auth/email-provider';
import type { Db } from '../db/client';
import { purgePairings } from '../db/connectors/pairing';
import { expirePendingConnectors } from '../db/connectors/registry';
import { applyRetention, removeUnreferencedObjects } from '../db/lifecycle';
import type { Storage } from '../storage/storage';
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

export const RETENTION = 'maintenance.retention';
/** Daily, at 03:29. */
export const RETENTION_CRON = '29 3 * * *';

export const REMOVE_UNREFERENCED_OBJECTS = 'maintenance.remove-unreferenced-objects';
/** Daily, at 04:13, after retention has anonymised the accounts that were due. */
export const REMOVE_UNREFERENCED_OBJECTS_CRON = '13 4 * * *';

/** The explicit retention policy (§13): a null period leaves that rule off. */
export interface RetentionPolicy {
  deactivatedGraceDays: number | null;
  auditEventDays: number | null;
}

export const retentionPolicy = (config: {
  RETENTION_DEACTIVATED_GRACE_DAYS?: number | undefined;
  RETENTION_AUDIT_DAYS?: number | undefined;
}): RetentionPolicy | undefined => {
  const policy = {
    deactivatedGraceDays: config.RETENTION_DEACTIVATED_GRACE_DAYS ?? null,
    auditEventDays: config.RETENTION_AUDIT_DAYS ?? null,
  };
  // With every period unset there is nothing to run, so the queue is not even scheduled.
  return policy.deactivatedGraceDays === null && policy.auditEventDays === null
    ? undefined
    : policy;
};

type Maintenance = { name: string; cron: string; run: (db: Db, now: Date) => Promise<object> };

const maintenance: Maintenance[] = [
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
export async function workMaintenance(
  boss: PgBoss,
  db: Db,
  log: JobLogger,
  storage: Storage,
  policy?: RetentionPolicy,
): Promise<string[]> {
  // Deleted rows can leave their objects behind whatever the policy (an account deleted by its
  // owner), so the sweep always runs.
  const sweep: Maintenance = {
    name: REMOVE_UNREFERENCED_OBJECTS,
    cron: REMOVE_UNREFERENCED_OBJECTS_CRON,
    run: (d, now) => removeUnreferencedObjects(d, storage, now),
  };
  const all = policy
    ? [
        ...maintenance,
        sweep,
        {
          name: RETENTION,
          cron: RETENTION_CRON,
          run: (d: Db, now: Date) => applyRetention(d, policy, now),
        },
      ]
    : [...maintenance, sweep];
  if (!policy) {
    // pg-boss keeps schedules in the database: one left by an earlier policy would keep queuing
    // jobs that nothing works.
    await boss.unschedule(RETENTION).catch((err: unknown) => {
      log.warn({ err, job: RETENTION }, 'maintenance unschedule failed');
    });
  }
  for (const { name, cron, run } of all) {
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
  return all.map((m) => m.name);
}
