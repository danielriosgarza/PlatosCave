import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const migrationsFolder = resolve(import.meta.dirname, '../../drizzle');

/**
 * Stops before anything is applied when the database holds a migration newer than the newest of
 * this package (docs/design/site.md §10): drizzle's migrator would apply nothing, and an older
 * server would start on a newer schema. Migrations only move forward.
 */
export async function assertNotNewer(pool: pg.Pool): Promise<void> {
  const journal = readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8');
  const ours = Math.max(...JSON.parse(journal).entries.map((e: { when: number }) => e.when));
  const table = await pool.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
  if (!table.rows[0]?.t) return;
  const newest = 'select max(created_at) as at from drizzle.__drizzle_migrations';
  const theirs = Number((await pool.query(newest)).rows[0]?.at ?? 0);
  if (theirs <= ours) return;
  const [db, own] = [theirs, ours].map((at) => new Date(at).toISOString());
  throw new Error(
    `the database holds a migration of ${db}, newer than this version's newest, of ${own}. ` +
      'Install the version that wrote it, or restore the backup taken before the upgrade with ' +
      'the earlier version (docs/backup-restore.md).',
  );
}

export async function runMigrations(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await assertNotNewer(pool);
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await runMigrations(url).catch((error: Error) => {
    console.error(`migrate: ${error.message}`);
    process.exit(1);
  });
  console.log('migrations applied');
}
