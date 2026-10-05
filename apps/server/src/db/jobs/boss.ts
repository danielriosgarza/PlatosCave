import type pg from 'pg';
import { PgBoss, type Warning } from 'pg-boss';

/** pg-boss keeps its queue tables in this schema of the application database (ADR-0001). */
export const BOSS_SCHEMA = 'pgboss';

/** The runner's channel (docs/design/runner.md §8.4): `execution.*` queues only. */
export const EXEC_SCHEMA = 'pgboss_exec';

export interface CreateBossOptions {
  /** Schema of the queue tables; defaults to the application's `pgboss`. */
  schema?: typeof BOSS_SCHEMA | typeof EXEC_SCHEMA;
  /** Workers maintain queues and expire stalled jobs; an API process only sends. */
  role: 'api' | 'worker';
  /** Runs pg-boss's cron scheduler, so schedules fire; only the worker process sets it. */
  schedule?: boolean;
  onError: (err: Error) => void;
  /** Operational problems pg-boss reports (queue backlog, slow queries, missing LISTEN). */
  onWarning: (warning: Warning) => void;
}

/**
 * pg-boss running its statements on the application pool, so jobs share the pool's limits and
 * shutdown instead of opening a second set of connections. `start()` installs or migrates the
 * schema, guarded by pg-boss's own advisory lock, so API and worker can start together.
 */
export function createBoss(
  pool: pg.Pool,
  { role, schema = BOSS_SCHEMA, schedule = false, onError, onWarning }: CreateBossOptions,
): PgBoss {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schema,
    supervise: role === 'worker',
    schedule,
  });
  // Without a listener an emitted error would crash the process.
  boss.on('error', onError);
  boss.on('warning', onWarning);
  return boss;
}
