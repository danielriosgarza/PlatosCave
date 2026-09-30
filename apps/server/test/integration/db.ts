import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/client';
import { TEMPLATE_DB } from './global-setup';

export interface TestDatabase {
  url: string;
  db: Db;
  drop: () => Promise<void>;
}

/** Clones the migrated template into a fresh database so each test file is isolated. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for integration tests');
  const name = `test_${randomBytes(6).toString('hex')}`;

  const admin = new URL(base);
  admin.pathname = '/postgres';
  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(
      `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(TEMPLATE_DB)}`,
    );
  } finally {
    await adminClient.end();
  }

  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  const { db, pool } = createDb(url);

  return {
    url,
    db,
    drop: async () => {
      await pool.end();
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      try {
        await client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
