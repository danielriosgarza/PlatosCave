import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import { createDb } from '../../db/client';
import type { Storage } from '../../storage/storage';

const TOKEN = 'probe-token-0123456789';
const PROBE = { 'x-ready-token': TOKEN };
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', READY_PROBE_TOKEN: TOKEN });

const storage = (head: Storage['head']): Storage => ({
  put: async () => {
    throw new Error('unused');
  },
  get: async () => ({ body: Readable.from([]), size: 0 }),
  head,
  delete: async () => undefined,
  list: async function* () {},
});

test('ready answers 503 and says which required dependency is missing when none is configured', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE });
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
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE });
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
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE });
  expect(res.statusCode).toBe(503);
  expect(res.json().checks.storage).toMatchObject({ status: 'unavailable', required: true });
  expect(res.body).not.toMatch(/ECONNREFUSED|secret-bucket|s3\.internal/);
  await app.close();
});

test('ready asks the store itself, so a missing bucket is not ok even though a HEAD of a key is null', async () => {
  const missingBucket: Storage = {
    ...storage(async () => null),
    ping: async () => {
      throw new Error('NoSuchBucket');
    },
  };
  const app = await buildApp(config, { storage: missingBucket });
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE });
  expect(res.statusCode).toBe(503);
  expect(res.json().checks.storage).toMatchObject({ status: 'unavailable', required: true });
  await app.close();
});

test('ready gives up on a storage call that never answers', async () => {
  const app = await buildApp(config, {
    probeTimeoutMs: 50,
    storage: storage(() => new Promise(() => undefined)),
  });
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE });
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

const REMOTE = { remoteAddress: '203.0.113.9' };
const configWith = (env: Record<string, string>) =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', READY_PROBE_TOKEN: TOKEN, ...env });

test('ready gives a caller without the probe token the status alone, no version or dependency detail', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const res = await app.inject({ method: 'GET', url: '/api/ready', ...REMOTE });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ status: 'not_ready' });
  expect(res.body).not.toMatch(/version|database|storage|queue|latencyMs/);
  await app.close();
});

test('ready gives loopback and relayed callers no detail without the token', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const asked = [
    await app.inject({ method: 'GET', url: '/api/ready' }),
    await app.inject({ method: 'GET', url: '/api/ready', remoteAddress: '127.0.0.2' }),
    await app.inject({
      method: 'GET',
      url: '/api/ready',
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
    }),
  ];
  for (const res of asked) expect(res.json()).toEqual({ status: 'not_ready' });
  await app.close();
});

test('ready gives the detail to the configured probe token and to no other value', async () => {
  const app = await buildApp(config, { storage: storage(async () => null) });
  const ask = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/ready', headers, ...REMOTE });
  expect((await ask(PROBE)).json()).toHaveProperty('checks');
  expect((await ask({ 'x-ready-token': 'probe-token-0123456780' })).json()).toEqual({
    status: 'not_ready',
  });
  expect((await ask({ 'x-ready-token': '' })).json()).toEqual({ status: 'not_ready' });
  await app.close();
});

test('ready without a configured token gives nobody the detail, whatever header is sent', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    storage: storage(async () => null),
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/ready',
    headers: { 'x-ready-token': 'undefined' },
  });
  expect(res.json()).toEqual({ status: 'not_ready' });
  await app.close();
});

test('ready limits callers without the token per address, and never counts one that sends it', async () => {
  const app = await buildApp(configWith({ READY_RATE_LIMIT: '1' }), {
    storage: storage(async () => null),
  });
  const ask = (address: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/ready', headers, remoteAddress: address });
  expect((await ask('203.0.113.9')).statusCode).toBe(503);
  const limited = await ask('203.0.113.9');
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toMatchObject({ error: 'too many requests' });
  expect((await ask('203.0.113.10')).statusCode).toBe(503);
  // From a non-loopback address (a proxy's, through Docker's port forwarding), with the token.
  for (let i = 0; i < 5; i++) {
    const res = await ask('172.18.0.1', PROBE);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toHaveProperty('checks');
  }
  await app.close();
});

test('ready accepts a probe token that was configured with surrounding whitespace', async () => {
  const app = await buildApp(configWith({ READY_PROBE_TOKEN: `  ${TOKEN}\n` }), {
    storage: storage(async () => null),
  });
  const res = await app.inject({ method: 'GET', url: '/api/ready', headers: PROBE, ...REMOTE });
  expect(res.json()).toHaveProperty('checks');
  await app.close();
});
