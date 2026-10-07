import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { BackgroundTasks } from '../../src/background';
import { loadConfig } from '../../src/config';
import { createBoss, EXEC_SCHEMA } from '../../src/db/jobs/boss';
import { authSessions, users } from '../../src/db/schema';
import { ensureExecQueues } from '../../src/execution/queues';
import { buildWorld, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { attemptUrl, call, type ExecWorld, execWorld, requestRun, startAttempt } from './execution';
import {
  call as callRelay,
  insertNotebook,
  liveConnector,
  saveConnection,
} from './notebook-sessions';
import { startRelay } from './relay';

/**
 * P4-12 operational readiness (spec §13, §14, §17): the readiness endpoint against a real
 * database and queue, the per-session limit on run requests, and the session and lease defaults
 * an operator sets in the environment.
 */

const start = new Date('2026-10-01T09:00:00Z');

describe('readiness with a real database, queue and object store', () => {
  let testDb: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    pool = new pg.Pool({ connectionString: testDb.url, max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
    await testDb?.drop();
  });

  test('ready answers 200 with each dependency ok when the queues are started', async () => {
    const boss = createBoss(pool, {
      role: 'api',
      schema: EXEC_SCHEMA,
      onError: () => undefined,
      onWarning: () => undefined,
    });
    await boss.start();
    await ensureExecQueues(boss);
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
      db: testDb.db,
      boss,
      bossExec: boss,
    });
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok', required: true },
        queue: { status: 'ok', required: true },
        executionQueue: { status: 'ok', required: false },
        storage: { status: 'ok', required: true },
      },
    });
    await app.close();
    await boss.stop({ graceful: false, close: false });
  });

  test('ready answers 503 when the job queue did not start, and health still answers 200', async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
      db: testDb.db,
    });
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'ok' }, queue: { status: 'skipped', required: true } },
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('run requests are limited per session', () => {
  let w: ExecWorld;
  let attempt: string;

  beforeAll(async () => {
    w = await execWorld({ runRateLimit: 3 });
    attempt = await startAttempt(w, 'sam', ids.classA);
  });
  afterAll(async () => {
    await w?.close();
  });

  test('a student past RUN_RATE_LIMIT answers 429 whatever the run cap says, others are unaffected', async () => {
    // The same code each time: the run is reused, so the two-run cap never speaks.
    const answers: number[] = [];
    for (let i = 0; i < 3; i++) {
      answers.push((await requestRun(w, 'sam', ids.classA, attempt, 'mean', '# same\n')).status);
    }
    expect(answers.every((s) => s === 202 || s === 200)).toBe(true);
    const fourth = await requestRun(w, 'sam', ids.classA, attempt, 'mean', '# same\n');
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ error: 'too many requests' });
    expect(fourth.body).not.toMatchObject({ error: 'too_many_runs' });

    // Another session has its own budget (it is refused for another reason: not its attempt).
    const other = await requestRun(w, 'bea', ids.classA, attempt, 'mean', '# same\n');
    expect(other.status).not.toBe(429);

    // Reading a run is not a run request.
    const read = await call(
      w,
      'sam',
      'GET',
      `${attemptUrl(ids.classA, attempt)}/questions/mean/runs?latest=1`,
    );
    expect(read.status).toBe(200);
  });
});

describe('session lifetime from SESSION_TTL_DAYS', () => {
  let testDb: TestDatabase;
  let mailDir: string;
  const background = new BackgroundTasks();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await buildWorld(testDb.db, start);
    mailDir = await mkdtemp(join(tmpdir(), 'parallax-p412-mail-'));
  });
  afterAll(async () => {
    await testDb?.drop();
    if (mailDir) await rm(mailDir, { recursive: true, force: true });
  });

  test('a sign-in lasts SESSION_TTL_DAYS: cookie lifetime and stored expiry agree', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ORIGIN: 'http://app.parallax.test',
      MAIL_DIR: mailDir,
      SESSION_TTL_DAYS: '3',
    });
    const app = await buildApp(config, { db: testDb.db, now: () => start, background });
    const email = 'sam@example.test';
    const requested = await app.inject({
      method: 'POST',
      url: '/api/auth/link',
      payload: { email },
    });
    expect(requested.statusCode).toBe(202);
    await background.settled();
    const files = (await readdir(mailDir)).filter((f) => f.endsWith('.json'));
    const mail = JSON.parse(await readFile(join(mailDir, files[0] as string), 'utf8')) as {
      text: string;
    };
    const link = new URL(mail.text.match(/https?:\/\/\S+/)?.[0] as string);
    const verified = await app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(verified.statusCode).toBe(302);
    const cookie = [verified.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith('pc_session='));
    expect(cookie).toMatch(/Max-Age=259200\b/);
    const rows = await testDb.db
      .select({ expiresAt: authSessions.expiresAt, createdAt: authSessions.createdAt })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(users.email, email));
    // The world's own fixture session (14 days) is also Sam's; the sign-in just made is the 3-day one.
    expect(rows.map((r) => r.expiresAt.toISOString())).toContain(
      new Date(start.getTime() + 3 * 86_400_000).toISOString(),
    );
    await app.close();
  });
});

describe('notebook lease defaults from LEASE_IDLE_MINUTES and LEASE_GRACE_MINUTES', () => {
  let testDb: TestDatabase;
  let relay: Awaited<ReturnType<typeof startRelay>>;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    relay = await startRelay(testDb, start, {
      env: { LEASE_IDLE_MINUTES: '60', LEASE_GRACE_MINUTES: '10' },
    });
  });
  afterAll(async () => {
    await relay?.close();
    await testDb?.drop();
  });

  test('open_session carries the configured lease when no template or request names one', async () => {
    const revisionId = await insertNotebook(testDb.db, start);
    const cookie = relay.world.cookie.sam;
    const live = await liveConnector(relay);
    const connectionId = await saveConnection(relay, cookie, live.id, {});
    const res = await callRelay(
      relay,
      cookie,
      'POST',
      `/api/classes/${ids.classA}/notebook-sessions`,
      {
        connectionId,
        revisionId,
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const request = await live.connector.next('open_session');
    expect(request).toMatchObject({ lease: { idleTimeoutMin: 60, gracePeriodMin: 10 } });
  });
});
