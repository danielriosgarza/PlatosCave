import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BOSS_SCHEMA, createBoss } from '../../src/jobs/boss';
import { createTestDatabase, type TestDatabase } from './db';

const serverDir = resolve(import.meta.dirname, '../..');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // Installs the pg-boss schema, so the worker's start() reads its version table.
  const boss = createBoss(testDb.db.$client, {
    role: 'api',
    onError: () => {},
    onWarning: () => {},
  });
  await boss.start();
  await boss.stop({ graceful: false, close: false });
});

afterAll(async () => {
  await testDb?.drop();
});

test('a worker whose startup hangs still exits within the stop budget on SIGTERM', async () => {
  // Holding the version table makes boss.start() wait on the database indefinitely.
  const blocker = new pg.Client({ connectionString: testDb.url });
  await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query(`lock table ${BOSS_SCHEMA}.version in access exclusive mode`);

    const worker = spawn(resolve(serverDir, 'node_modules/.bin/tsx'), ['src/main.ts', 'worker'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: testDb.url, NODE_ENV: 'test', LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    worker.stdout.on('data', (chunk) => (output += chunk));
    worker.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((done) => worker.on('exit', (code) => done(code)));

    // Wait until the worker's startup is blocked on the lock.
    const name = new URL(testDb.url).pathname.slice(1);
    for (let i = 0; ; i++) {
      const { rows } = await testDb.db.$client.query(
        `select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'`,
        [name],
      );
      if (rows.length > 0) break;
      if (i > 100) throw new Error(`worker never reached the lock: ${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const signalled = Date.now();
    worker.kill('SIGTERM');
    const code = await exited;
    const elapsed = Date.now() - signalled;
    expect(code).toBe(1);
    // The 8 s budget, plus slack for process exit; well under a 10 s deploy grace period.
    expect(elapsed).toBeGreaterThanOrEqual(7_900);
    expect(elapsed).toBeLessThan(9_500);
    expect(output).toContain('worker startup did not settle within 8000 ms');
  } finally {
    await blocker.end();
  }
}, 30_000);
