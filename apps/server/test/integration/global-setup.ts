import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { withAdminClient } from '../../src/db/admin';
import { runMigrations } from '../../src/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Prefix shared by this run's template and clones: `parallax_test_<epoch-seconds>_<run>_`. */
    itestPrefix: string;
  }
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  return url;
}

/** Drops only this run's databases, so concurrent runs and unrelated databases are untouched. */
async function dropRun(prefix: string): Promise<void> {
  await withAdminClient(databaseUrl(), async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      'select datname from pg_database where starts_with(datname, $1)',
      [prefix],
    );
    for (const { datname } of rows) {
      await client.query(`drop database if exists ${pg.escapeIdentifier(datname)} with (force)`);
    }
  });
}

/** A run killed before teardown leaves its databases behind; runs older than this are swept. */
const STALE_AFTER_SECONDS = 60 * 60;
const PREFIX_PATTERN = /^parallax_test_(\d+)_[0-9a-f]+_/;

/** Drops leftovers of earlier killed runs (bounded by age, so concurrent runs are untouched). */
async function sweepStale(nowSeconds: number): Promise<void> {
  await withAdminClient(databaseUrl(), async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database where datname like 'parallax\\_test\\_%'`,
    );
    for (const { datname } of rows) {
      const started = PREFIX_PATTERN.exec(datname)?.[1];
      if (started && nowSeconds - Number(started) > STALE_AFTER_SECONDS) {
        await client.query(`drop database if exists ${pg.escapeIdentifier(datname)} with (force)`);
      }
    }
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = databaseUrl();
  const now = Math.floor(Date.now() / 1000);
  await sweepStale(now);
  const prefix = `parallax_test_${now}_${randomBytes(4).toString('hex')}_`;
  const template = `${prefix}template`;
  project.provide('itestPrefix', prefix);

  await withAdminClient(url, (client) =>
    client.query(`create database ${pg.escapeIdentifier(template)}`),
  );
  const templateUrl = new URL(url);
  templateUrl.pathname = `/${template}`;
  await runMigrations(templateUrl.toString());
  return () => dropRun(prefix);
}
