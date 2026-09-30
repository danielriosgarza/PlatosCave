import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate';

/** Creates the database if missing, recreates schema `public`, and migrates. Dev and e2e only. */
export async function resetDatabase(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run when NODE_ENV=production');
  }
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    const exists = await adminClient.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await adminClient.query(`create database ${pg.escapeIdentifier(name)}`);
    }
  } finally {
    await adminClient.end();
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists drizzle cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
  await runMigrations(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await resetDatabase(url);
  console.log('database reset');
}
