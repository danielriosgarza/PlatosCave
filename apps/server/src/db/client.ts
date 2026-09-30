import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  // Idle clients dropped by the server surface here; without a listener the process crashes.
  // The pool discards the dead client and reconnects on the next query.
  pool.on('error', (err) => console.error('pg pool error', err));
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
