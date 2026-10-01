import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { describe, expect, test } from 'vitest';
import type { Db } from '../db/client';
import type { JobLogger } from './logger';
import { PURGE_SIGNIN_TOKENS, workMaintenance } from './maintenance';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.(test|itest)\.ts$/.test(entry.name) ? [path] : [];
  });
}

// ADR-0002 "Jobs and sockets": a queue worked outside `workScopedJob` has no actor and no scope
// check. This pins the set so a later job cannot copy the maintenance pattern for class- or
// course-scoped data without a reviewer seeing this test change.
describe('queues outside workScopedJob', () => {
  test('only maintenance.ts registers a worker besides the scoped wrapper', () => {
    const files = sourceFiles(srcDir)
      .filter((file) => /\.work\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file).split('\\').join('/'))
      .sort();
    expect(files).toEqual(['jobs/maintenance.ts', 'jobs/scoped.ts']);
  });

  test('the worker runs exactly one unscoped queue: maintenance.purge-signin-tokens', async () => {
    const worked: string[] = [];
    const boss = {
      createQueue: async () => {},
      schedule: async () => {},
      work: async (name: string) => void worked.push(name),
    } as unknown as PgBoss;
    const quiet = { info() {}, warn() {}, error() {} } as unknown as JobLogger;
    const returned = await workMaintenance(boss, {} as Db, quiet);
    expect(returned).toEqual(['maintenance.purge-signin-tokens']);
    expect(worked).toEqual([PURGE_SIGNIN_TOKENS]);
  });
});
