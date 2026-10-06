import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { describe, expect, test } from 'vitest';
import type { Db } from '../db/client';
import type { JobLogger } from './logger';
import { PURGE_CONNECTOR_PAIRINGS, PURGE_SIGNIN_TOKENS, workMaintenance } from './maintenance';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.(test|itest)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** A pg-boss worker registration, including the typed form `boss.work<Payload>(…)`. */
const registersWorker = (source: string) => /\.work\s*[<(]/.test(source);

// ADR-0002 "Jobs and sockets": a queue worked outside `workScopedJob` has no actor and no scope
// check. This pins the set so a later job cannot copy the maintenance pattern for class- or
// course-scoped data without a reviewer seeing this test change.
describe('queues outside workScopedJob', () => {
  test('only maintenance.ts and the runner channel register a worker besides the scoped wrapper', () => {
    const files = sourceFiles(srcDir)
      .filter((file) => registersWorker(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file).split('\\').join('/'))
      .sort();
    // execution/handlers.ts consumes the runner's results and dead letters in pgboss_exec,
    // which carry no actor (docs/design/runner.md §8.4, the exception ADR-0002 records).
    expect(files).toEqual(['execution/handlers.ts', 'jobs/maintenance.ts', 'jobs/scoped.ts']);
  });

  test('the worker-registration pattern matches plain and typed calls only', () => {
    expect(registersWorker("await boss.work('q', handler);")).toBe(true);
    expect(registersWorker("await boss.work<{ classId: string }>('q', handler);")).toBe(true);
    expect(registersWorker("await boss\n  .work <X>('q', handler);")).toBe(true);
    expect(registersWorker('const network = 1; // frameworks')).toBe(false);
  });

  test('the worker runs exactly the unscoped maintenance queues', async () => {
    const worked: string[] = [];
    const boss = {
      createQueue: async () => {},
      schedule: async () => {},
      unschedule: async () => {},
      work: async (name: string) => void worked.push(name),
    } as unknown as PgBoss;
    const quiet = { info() {}, warn() {}, error() {} } as unknown as JobLogger;
    const returned = await workMaintenance(boss, {} as Db, quiet);
    expect(returned).toEqual([
      'maintenance.purge-signin-tokens',
      'maintenance.purge-connector-pairings',
    ]);
    expect(worked).toEqual([PURGE_SIGNIN_TOKENS, PURGE_CONNECTOR_PAIRINGS]);
  });
});
