import type pg from 'pg';
import { PgBoss, type Warning } from 'pg-boss';

/** pg-boss keeps its queue tables in this schema of the application database (ADR-0001). */
export const BOSS_SCHEMA = 'pgboss';

export interface CreateBossOptions {
  /** Workers maintain queues and expire stalled jobs; an API process only sends. */
  role: 'api' | 'worker';
  onError: (err: Error) => void;
  /** Operational problems pg-boss reports (queue backlog, slow queries, missing LISTEN). */
  onWarning: (warning: Warning) => void;
}

/**
 * pg-boss running its statements on the application pool, so jobs share the pool's limits and
 * shutdown instead of opening a second set of connections. `start()` installs or migrates the
 * `pgboss` schema, guarded by pg-boss's own advisory lock, so API and worker can start together.
 */
export function createBoss(pool: pg.Pool, { role, onError, onWarning }: CreateBossOptions): PgBoss {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schema: BOSS_SCHEMA,
    supervise: role === 'worker',
    schedule: false,
  });
  // Without a listener an emitted error would crash the process.
  boss.on('error', onError);
  boss.on('warning', onWarning);
  return boss;
}
