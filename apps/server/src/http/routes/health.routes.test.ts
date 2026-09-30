import { expect, test } from 'vitest';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import { createDb } from '../../db/client';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

test('health reports the database as skipped when none is configured', async () => {
  const app = await buildApp(config);
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.json()).toMatchObject({ status: 'ok', db: 'skipped' });
  await app.close();
});

test('health reports the database as unavailable when it cannot be reached', async () => {
  const { db, pool } = createDb('postgres://x@127.0.0.1:1/x');
  const app = await buildApp(config, { db });
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok', db: 'unavailable' });
  await app.close();
  await pool.end();
});
