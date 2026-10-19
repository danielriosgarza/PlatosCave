import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, expect, test } from 'vitest';
import { dropDatabases, emptyDatabase } from './backup';

const server = resolve(import.meta.dirname, '../..');
const folder = join(server, 'drizzle');
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
const when: number[] = journal.entries.map((entry: { when: number }) => entry.when);
const temp = mkdtempSync(join(tmpdir(), 'parallax-a52-'));
afterAll(async () => {
  await dropDatabases();
  rmSync(temp, { recursive: true, force: true });
});

/** `src/db/migrate.ts` run as the `migrate` service runs it, on the database at `url`. */
const migrateScript = (url: string) =>
  new Promise<{ code: number; stderr: string }>((done) => {
    const env = { ...process.env, DATABASE_URL: url };
    const args = ['--import', 'tsx', 'src/db/migrate.ts'];
    execFile(process.execPath, args, { cwd: server, env }, (error, _, stderr) =>
      done({ code: error ? Number(error.code ?? 1) : 0, stderr }),
    );
  });

/** The migrations a database records, and each of its tables with its columns. */
async function state(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const columns = `select table_schema || '.' || table_name || ': ' || string_agg(column_name, ',' order by column_name) as t
      from information_schema.columns where table_schema not in ('pg_catalog', 'information_schema')
      group by table_schema, table_name order by 1`;
    const tables = (await client.query<{ t: string }>(columns)).rows.map(({ t }) => t);
    const there = await client.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
    const rows = there.rows[0]?.t
      ? await client.query<{ at: string }>(
          'select created_at as at from drizzle.__drizzle_migrations order by id',
        )
      : { rows: [] };
    return { tables, migrations: rows.rows.map(({ at }) => Number(at)) };
  } finally {
    await client.end();
  }
}

test('A52 an upgrade migrates forward and a database newer than the package is refused', async () => {
  // An empty database, and one that an earlier version migrated, are brought to the newest.
  const [empty, earlier] = [await emptyDatabase(), await emptyDatabase()];
  const older = join(temp, 'drizzle');
  cpSync(folder, older, { recursive: true });
  const entries = journal.entries.slice(0, 10);
  writeFileSync(join(older, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  const pool = new pg.Pool({ connectionString: earlier, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: older }).finally(() => pool.end());
  expect((await state(earlier)).migrations).toEqual(when.slice(0, 10));
  for (const url of [empty, earlier]) {
    expect(await migrateScript(url)).toMatchObject({ code: 0 });
    expect((await state(url)).migrations).toEqual(when);
  }

  // A database that a later version migrated is refused, with both dates, and left as it was.
  const later = Math.max(...when) + 86_400_000;
  const client = new pg.Client({ connectionString: earlier });
  await client.connect();
  await client.query(
    `insert into drizzle.__drizzle_migrations (hash, created_at) values ('a52', $1)`,
    [later],
  );
  await client.end();
  const before = await state(earlier);
  const refused = await migrateScript(earlier);
  expect(refused.code).not.toBe(0);
  for (const at of [later, Math.max(...when)]) {
    expect(refused.stderr).toContain(new Date(at).toISOString());
  }
  expect(await state(earlier)).toEqual(before);
});
