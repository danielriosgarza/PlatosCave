import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { buildWorld, ids, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * P2-15a (§10.7, §12): the draft API accepts only usable Shiny addresses, and publication
 * validation warns when an address is not on an origin the host approved.
 */

const now = new Date('2026-10-01T09:00:00Z');
const APPROVED = 'https://shiny.example.org';
const course = `/api/courses/${ids.statistics}`;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', SHINY_ORIGINS: APPROVED }),
    { db: testDb.db, now: () => now },
  );
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

const send = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: world.cookie.elena },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
};
const create = (title: string, content: unknown, extra: object = {}) =>
  send('POST', `${course}/topics/${ids.sampling}/resources`, {
    type: 'shiny',
    title,
    content,
    ...extra,
  });
const warnings = async () =>
  (await send('GET', `${course}/releases/validation`)).body.warnings.filter(
    (w: { code: string }) => w.code === 'unapproved_shiny_origin',
  );

describe('P2-15a Shiny address authoring', () => {
  test('P2-15a the draft API keeps an https address and an http address on loopback', async () => {
    for (const url of [`${APPROVED}/lab/?lang=en`, 'http://localhost:3838/lab']) {
      const created = await create(`Lab ${url}`, { url });
      expect(created.status).toBe(200);
      expect(created.body.head.content).toEqual({ url });
    }
  });

  test('P2-15a the draft API refuses a missing address, other schemes, credentials and plain http elsewhere', async () => {
    for (const content of [
      {},
      { url: 'not an address' },
      { url: 'javascript:alert(1)' },
      { url: 'http://shiny.example.org/' },
      { url: 'https://user:secret@shiny.example.org/' },
      { url: 7 },
    ]) {
      const created = await create('Refused lab', content);
      expect(created.status, JSON.stringify(content)).toBe(400);
    }
  });

  test('P2-15a editing a Shiny resource validates its new address too', async () => {
    const created = await create('Edited lab', { url: `${APPROVED}/a` });
    const base = `${course}/resources/${created.body.id}`;
    const bad = await send('PATCH', base, {
      expectedRevision: created.body.revision,
      content: { url: 'ftp://shiny.example.org/' },
    });
    expect(bad.status).toBe(400);
    const good = await send('PATCH', base, {
      expectedRevision: created.body.revision,
      content: { url: `${APPROVED}/b` },
    });
    expect(good.status).toBe(200);
    expect(good.body.head.content).toEqual({ url: `${APPROVED}/b` });
  });

  test('P2-15a publication validation warns, without blocking, for an address off the approved origins', async () => {
    const before = await warnings();
    const off = await create('Elsewhere lab', { url: 'https://other.example.org/lab' });
    const after = await warnings();
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContainEqual({
      code: 'unapproved_shiny_origin',
      message: expect.stringContaining('Elsewhere lab'),
      topicId: ids.sampling,
      resourceId: off.body.id,
    });
    const report = (await send('GET', `${course}/releases/validation`)).body;
    expect(report.errors).toEqual([]);
  });

  test('P2-15a an address on an approved origin raises no warning', async () => {
    const before = await warnings();
    await create('Approved lab', { url: `${APPROVED}/fine` });
    expect(await warnings()).toHaveLength(before.length);
  });
});
