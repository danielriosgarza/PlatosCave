import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export interface CreateDbOptions {
  /** Receives errors from idle pooled clients; defaults to console.error. */
  onError?: (err: Error) => void;
}

export function createDb(url: string, { onError }: CreateDbOptions = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    // Detects a dead peer on long application and worker queries without capping their duration.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // Idle clients dropped by the server surface here; without a listener the process crashes.
  // The pool discards the dead client and reconnects on the next query.
  pool.on('error', onError ?? ((err) => console.error('pg pool error', err)));
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
/** The handle inside `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either: queries that may run alone or inside a caller's transaction take this. */
export type Executor = Db | Tx;

/** Client-side deadline for the health probe; application queries have none. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * `select 1` with its own client-side deadline: a server-side statement_timeout cannot help
 * on a silent link. The deadline applies to this query only, so long-running application
 * queries (snapshots, exports, grading batches) are not capped.
 */
export async function probe(db: Db, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<void> {
  // node-postgres honours query_timeout per query, but @types/pg omits it from QueryConfig.
  await db.$client.query({ text: 'select 1', query_timeout: timeoutMs } as pg.QueryConfig);
}
