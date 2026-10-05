import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EXEC_SCHEMA, FAILED_QUEUE, RESULT_QUEUE, RUN_QUEUE } from '../src/worker';
import { createTestDatabase, type TestDatabase } from './db';

const SCRIPT = new URL('../../../scripts/runner-role.sql', import.meta.url);

let testDb: TestDatabase;
let admin: pg.Client;
/** A connection acting as `parallax_runner` through `SET ROLE`. */
let runner: pg.Client;
const bosses: PgBoss[] = [];

/** `scripts/runner-role.sql` with psql's `:app_role` substituted, as P3-16's migration does. */
function roleScript(appRole: string): string {
  return readFileSync(SCRIPT, 'utf8').replaceAll(':app_role', pg.escapeIdentifier(appRole));
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** The Postgres error code a statement fails with, or null when it succeeds. */
async function sqlState(client: pg.Client, sql: string): Promise<string | null> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT probe');
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = await connect(testDb.url);
  const { rows } = await admin.query<{ role: string }>('SELECT current_user AS role');
  const appRole = rows[0]?.role as string;

  // The application's pg-boss in `pgboss`, holding scoped jobs whose payloads name an actor.
  const app = new PgBoss({ connectionString: testDb.url, max: 2 });
  bosses.push(app);
  await app.start();
  await app.createQueue('test.scoped');
  await app.send('test.scoped', { actorId: 'someone' });

  // The role statements run before pg-boss first creates its tables in pgboss_exec, so the
  // queue tables reach the runner through the default privileges (design §8.3, §10.3).
  await admin.query(roleScript(appRole));
  await admin.query('GRANT parallax_runner TO current_user');
  const exec = new PgBoss({ connectionString: testDb.url, max: 2, schema: EXEC_SCHEMA });
  bosses.push(exec);
  await exec.start();
  await exec.createQueue(FAILED_QUEUE);
  await exec.createQueue(RESULT_QUEUE, { policy: 'short' });
  await exec.createQueue(RUN_QUEUE, { deadLetter: FAILED_QUEUE, retryLimit: 0 });

  runner = await connect(testDb.url);
  await runner.query('SET ROLE parallax_runner');
  await runner.query('BEGIN');
});

afterAll(async () => {
  await runner?.query('ROLLBACK').catch(() => undefined);
  await runner?.end();
  for (const boss of bosses) await boss.stop({ graceful: false, close: true });
  await admin?.end();
  await testDb?.drop();
});

describe('A13 runner role (design §10.3)', () => {
  test('A13 runner role cannot read application tables or the application job queue', async () => {
    const { rows } = await runner.query<{ role: string }>('SELECT current_user AS role');
    expect(rows[0]?.role).toBe('parallax_runner');
    const denied = '42501';
    expect(await sqlState(runner, 'SELECT * FROM users LIMIT 1')).toBe(denied);
    expect(await sqlState(runner, 'SELECT * FROM resource_revisions LIMIT 1')).toBe(denied);
    // P3-16: the run records, which name a student, attempt and question, stay out of reach.
    expect(await sqlState(runner, 'SELECT * FROM execution_results LIMIT 1')).toBe(denied);
    expect(await sqlState(runner, 'SELECT * FROM execution_jobs LIMIT 1')).toBe(denied);
    expect(
      await sqlState(runner, `UPDATE execution_results SET status = 'passed' WHERE false`),
    ).toBe(denied);
    expect(await sqlState(runner, 'SELECT * FROM pgboss.job LIMIT 1')).toBe(denied);
    expect(
      await sqlState(
        runner,
        `INSERT INTO pgboss.job (name, data) VALUES ('test.scoped', '{"actorId":"forged"}')`,
      ),
    ).toBe(denied);
  });

  test('A13 runner role reads pgboss_exec', async () => {
    expect(await sqlState(runner, 'SELECT version FROM pgboss_exec.version')).toBeNull();
    expect(await sqlState(runner, 'SELECT name FROM pgboss_exec.queue')).toBeNull();
  });

  test('A13 runner role can create nothing in public', async () => {
    expect(await sqlState(runner, 'CREATE TABLE public.runner_probe (id int)')).toBe('42501');
  });

  test("A13 pg-boss's worker path runs as the runner role", async () => {
    // A dedicated session acting as the role, as `apps/runner` does with its own login.
    const session = await connect(testDb.url);
    await session.query('SET ROLE parallax_runner');
    const app = bosses[1] as PgBoss;
    const asRunner = new PgBoss({
      db: { executeSql: (text, values) => session.query(text, values) },
      schema: EXEC_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    try {
      await asRunner.start();
      const jobId = await app.send(RUN_QUEUE, { probe: 1 });
      const [fetched] = await asRunner.fetch(RUN_QUEUE);
      expect(fetched?.id).toBe(jobId);
      await asRunner.send(RESULT_QUEUE, { ok: true }, { id: fetched?.id, singletonKey: 'k' });
      await asRunner.complete(RUN_QUEUE, fetched?.id as string, { done: true });
      expect((await app.getJobById(RUN_QUEUE, jobId as string))?.state).toBe('completed');
      expect(await app.getJobById(RESULT_QUEUE, jobId as string)).not.toBeNull();
    } finally {
      await asRunner.stop({ graceful: false, close: false });
      await session.end();
    }
  });
});
