import net from 'node:net';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/db/client';
import { createTestDatabase, type TestDatabase } from './db';

let testDb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), { db: testDb.db });
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

test('health reports the database as ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
});

test('the migrated template contains app_settings', async () => {
  const res = await testDb.db.execute(
    sql`select to_regclass('public.app_settings') is not null as present`,
  );
  expect(res.rows[0]).toEqual({ present: true });
});

test('openapi lists /api/health', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  expect(res.statusCode).toBe(200);
  expect(Object.keys(res.json().paths)).toContain('/api/health');
});

test('health survives the server dropping an idle pooled connection', async () => {
  const { db, pool } = createDb(testDb.url);
  const quiet = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), { db });
  try {
    const pid = (await db.execute(sql`select pg_backend_pid() as pid`)).rows[0]?.pid;
    expect(pid).toBeTypeOf('number');
    const gone = new Promise((resolve) => pool.once('error', resolve));
    const term = await testDb.db.execute(sql`select pg_terminate_backend(${pid}) as ok`);
    expect(term.rows[0]).toEqual({ ok: true });
    await gone;
    const res = await quiet.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  } finally {
    await quiet.close();
    await pool.end();
  }
});

test('health reports unavailable when an established connection goes silent', async () => {
  // A TCP relay to Postgres that can be muted: bytes stop flowing but the sockets stay open.
  const target = new URL(testDb.url);
  let muted = false;
  const sockets = new Set<net.Socket>();
  const relay = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => s.destroy());
    }
    client.on('data', (d) => muted || upstream.write(d));
    upstream.on('data', (d) => muted || client.write(d));
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const via = new URL(testDb.url);
  via.hostname = '127.0.0.1';
  via.port = String((relay.address() as net.AddressInfo).port);

  const { db, pool } = createDb(via.toString(), { onError: () => {} });
  const silent = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db,
    probeTimeoutMs: 500,
  });
  try {
    const before = await silent.inject({ method: 'GET', url: '/api/health' });
    expect(before.json()).toMatchObject({ db: 'ok' });
    muted = true;
    const started = Date.now();
    const res = await silent.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    await silent.close();
    for (const s of sockets) s.destroy();
    await pool.end();
    await new Promise((resolve) => relay.close(resolve));
  }
});

test('application queries are not capped by the health probe deadline', async () => {
  const res = await testDb.db.execute(sql`select pg_sleep(5.5), 1 as done`);
  expect(res.rows[0]).toMatchObject({ done: 1 });
});
