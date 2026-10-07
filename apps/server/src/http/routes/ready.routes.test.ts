import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import { createDb } from '../../db/client';
import type { Storage } from '../../storage/storage';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const storage = (head: Storage['head']): Storage => ({
  put: async () => {
    throw new Error('unused');
  },
  get: async () => ({ body: Readable.from([]), size: 0 }),
  head,
  delete: async () => undefined,
});

test('ready answers 503 and says which required dependency is missing when none is configured', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const res = await app.inject({ method: 'GET', url: '/api/ready' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({
    status: 'not_ready',
    mode: 'api',
    checks: {
      database: { status: 'skipped', required: true },
      queue: { status: 'skipped', required: true },
      executionQueue: { status: 'skipped', required: false },
      storage: { status: 'ok', required: true },
    },
  });
  await app.close();
});

test('ready reports an unreachable database as unavailable, and the same probe covers the queue', async () => {
  const { db, pool } = createDb('postgres://x@127.0.0.1:1/x');
  const boss = {} as never;
  const app = await buildApp(config, {
    db,
    boss,
    probeTimeoutMs: 500,
    storage: storage(async () => null),
  });
  const res = await app.inject({ method: 'GET', url: '/api/ready' });
  expect(res.statusCode).toBe(503);
  expect(res.json().checks).toMatchObject({
    database: { status: 'unavailable', required: true },
    queue: { status: 'unavailable', required: true },
  });
  await app.close();
  await pool.end();
});

test('ready reports a failing object store as unavailable without echoing its error', async () => {
  const app = await buildApp(config, {
    storage: storage(async () => {
      throw new Error('connect ECONNREFUSED s3.internal.example.org:9000 bucket=secret-bucket');
    }),
  });
  const res = await app.inject({ method: 'GET', url: '/api/ready' });
  expect(res.statusCode).toBe(503);
  expect(res.json().checks.storage).toMatchObject({ status: 'unavailable', required: true });
  expect(res.body).not.toMatch(/ECONNREFUSED|secret-bucket|s3\.internal/);
  await app.close();
});

test('ready gives up on a storage call that never answers', async () => {
  const app = await buildApp(config, {
    probeTimeoutMs: 50,
    storage: storage(() => new Promise(() => undefined)),
  });
  const res = await app.inject({ method: 'GET', url: '/api/ready' });
  expect(res.statusCode).toBe(503);
  expect(res.json().checks.storage.status).toBe('unavailable');
  await app.close();
});

test('ready is in the OpenAPI document and needs no session', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const spec = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  expect(Object.keys(spec.json().paths)).toContain('/api/ready');
  await app.close();
});
