import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { withAdminClient } from '../../src/db/admin';
import { createDb, type Db } from '../../src/db/client';

export interface TestDatabase {
  url: string;
  db: Db;
  drop: () => Promise<void>;
}

/**
 * `pool.end()` resolves once the pool's client list is empty, but each client's `end()` finishes
 * later. Dropping the database `with (force)` in that window kills a backend whose client is
 * still closing, which emits an unhandled 57P01. Wait for every client's `remove` event first.
 */
async function endPool(pool: pg.Pool): Promise<void> {
  let remaining = pool.totalCount;
  const allRemoved = new Promise<void>((resolve) => {
    if (remaining === 0) return resolve();
    pool.on('remove', () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    });
  });
  await pool.end();
  await allRemoved;
}

/** Clones the migrated template into a fresh database so each test file is isolated. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for integration tests');
  const prefix = inject('itestPrefix');
  const name = `${prefix}${randomBytes(6).toString('hex')}`;

  await withAdminClient(base, (client) =>
    client.query(
      `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(`${prefix}template`)}`,
    ),
  );

  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  const { db, pool } = createDb(url);

  return {
    url,
    db,
    drop: async () => {
      await endPool(pool);
      await withAdminClient(base, (client) =>
        client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`),
      );
    },
  };
}
