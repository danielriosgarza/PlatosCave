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
    // Client-side deadline: a server-side statement_timeout cannot help on a silent link.
    query_timeout: 5000,
  });
  // Idle clients dropped by the server surface here; without a listener the process crashes.
  // The pool discards the dead client and reconnects on the next query.
  pool.on('error', onError ?? ((err) => console.error('pg pool error', err)));
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
