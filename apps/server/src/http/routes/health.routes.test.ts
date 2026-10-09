import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import { createDb } from '../../db/client';

const TOKEN = 'health-probe-token-0123456789';
const PROBE = { 'x-ready-token': TOKEN };
const configWith = (env: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', READY_PROBE_TOKEN: TOKEN, ...env });

test('health reports the database as skipped to a probe when none is configured', async () => {
  const app = await buildApp(configWith());
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: PROBE });
  expect(res.json()).toMatchObject({ status: 'ok', db: 'skipped' });
  await app.close();
});

test('health reports the database as unavailable to a probe when it cannot be reached', async () => {
  const { db, pool } = createDb('postgres://x@127.0.0.1:1/x');
  const app = await buildApp(configWith(), { db });
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: PROBE });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok', db: 'unavailable' });
  await app.close();
  await pool.end();
});

test('health gives every other caller the status alone', async () => {
  const { db, pool } = createDb('postgres://x@127.0.0.1:1/x');
  const app = await buildApp(configWith(), { db });
  for (const headers of [
    {},
    { 'x-ready-token': 'wrong-token-0123456789' },
    { 'x-ready-token': '' },
  ]) {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  }
  await app.close();
  await pool.end();
});

test('health is the same for everyone when no probe token is configured', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: PROBE });
  expect(res.json()).toEqual({ status: 'ok' });
  await app.close();
});

test('health limits callers without the token per address, and never counts one that sends it', async () => {
  const app = await buildApp(configWith({ READY_RATE_LIMIT: '2' }));
  const ask = (address: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/health', headers, remoteAddress: address });
  expect((await ask('203.0.113.9')).statusCode).toBe(200);
  expect((await ask('203.0.113.9')).statusCode).toBe(200);
  const limited = await ask('203.0.113.9');
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toMatchObject({ error: 'too many requests' });
  expect(limited.json()).not.toHaveProperty('version');
  expect((await ask('203.0.113.10')).statusCode).toBe(200);
  for (let i = 0; i < 5; i++) {
    const res = await ask('203.0.113.9', PROBE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'skipped' });
  }
  await app.close();
});

test('health and ready keep separate budgets', async () => {
  const app = await buildApp(configWith({ READY_RATE_LIMIT: '1' }));
  const ask = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '203.0.113.9' });
  expect((await ask('/api/health')).statusCode).toBe(200);
  expect((await ask('/api/health')).statusCode).toBe(429);
  expect((await ask('/api/ready')).statusCode).not.toBe(429);
  await app.close();
});
