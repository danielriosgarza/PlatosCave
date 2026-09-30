import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './db';

let testDb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), { db: testDb.db });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
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
