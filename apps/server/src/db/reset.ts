import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { withAdminClient } from './admin';
import { runMigrations } from './migrate';

/**
 * Creates the database if missing, recreates schema `public` (dropping the job queue), and
 * migrates. Dev and e2e only.
 */
export async function resetDatabase(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run when NODE_ENV=production');
  }
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  await withAdminClient(url, async (admin) => {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await admin.query(`create database ${pg.escapeIdentifier(name)}`);
    }
  });

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists drizzle cascade');
    // Queued jobs name rows that no longer exist; pg-boss reinstalls its schema on start.
    await client.query('drop schema if exists pgboss cascade');
    await client.query('drop schema if exists pgboss_exec cascade');
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
