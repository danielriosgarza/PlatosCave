import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { createUser } from '../../src/db/identity';
import { buildWorld, cookieFor, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let world: World;
/** INSTRUCTOR_EMAILS names the new people, with odd case and spacing. */
let listed: FastifyInstance;
/** No INSTRUCTOR_EMAILS: the rule before the allow-list. */
let unlisted: FastifyInstance;
const cookie: Record<'ada' | 'ben' | 'cleo', string> = { ada: '', ben: '', cleo: '' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  // Three accounts without any membership; Ada and Ben are on the list, Cleo is not.
  for (const [key, email] of [
    ['ada', 'ada@example.test'],
    ['ben', 'ben.wright@example.test'],
    ['cleo', 'cleo@example.test'],
  ] as const) {
    const id = await createUser(testDb.db, { email, name: key });
    cookie[key] = cookieFor((await createSession(testDb.db, id, { now })).token);
  }
  const deps = { db: testDb.db, now: () => now };
  listed = await buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      INSTRUCTOR_EMAILS: ' Ada@Example.TEST ,  BEN.wright@example.test,',
    }),
    deps,
  );
  unlisted = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), deps);
  await Promise.all([listed.ready(), unlisted.ready()]);
});

afterAll(async () => {
  await listed?.close();
  await unlisted?.close();
  await testDb?.drop();
});

const cards = async (app: FastifyInstance, who: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/courses', headers: { cookie: who } });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const create = (app: FastifyInstance, who: string, title: string) =>
  app.inject({ method: 'POST', url: '/api/courses', headers: { cookie: who }, payload: { title } });

describe('INSTRUCTOR_EMAILS', () => {
  test('A02 an allow-listed email with no memberships creates a course and becomes its owner', async () => {
    expect(await cards(listed, cookie.ada)).toMatchObject({
      classes: [],
      courses: [],
      canCreateCourse: true,
    });
    const res = await create(listed, cookie.ada, 'Research methods');
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created.title).toBe('Research methods');
    expect((await cards(listed, cookie.ada)).courses).toEqual([
      expect.objectContaining({ courseId: created.id, owner: true, editor: true, publisher: true }),
    ]);
  });

  test('A02 case and surrounding whitespace in the list do not matter', async () => {
    expect((await cards(listed, cookie.ben)).canCreateCourse).toBe(true);
    expect((await create(listed, cookie.ben, 'Field ecology')).statusCode).toBe(200);
  });

  test('A02 an account not on the list that teaches nothing is refused', async () => {
    for (const who of [cookie.cleo, world.cookie.sam]) {
      expect((await cards(listed, who)).canCreateCourse).toBe(false);
      const res = await create(listed, who, 'Nope');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'not_instructor' });
    }
    expect((await cards(listed, cookie.cleo)).courses).toEqual([]);
  });

  test('A02 a preview principal never creates a course', async () => {
    expect((await cards(listed, world.cookie.previewB)).canCreateCourse).toBe(false);
    expect((await create(listed, world.cookie.previewB, 'Nope')).statusCode).toBe(403);
  });

  test('A02 people who already teach still create courses, list or not', async () => {
    for (const app of [listed, unlisted]) {
      expect((await cards(app, world.cookie.marcus)).canCreateCourse).toBe(true);
    }
    expect((await create(listed, world.cookie.ines, 'Survey design')).statusCode).toBe(200);
  });

  test('A02 an empty list changes nothing: an account that teaches nothing is refused', async () => {
    const before = await cards(unlisted, cookie.cleo);
    expect(before.canCreateCourse).toBe(false);
    const res = await create(unlisted, cookie.cleo, 'Nope');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_instructor' });
    expect((await cards(unlisted, cookie.cleo)).courses).toEqual([]);
    expect((await cards(unlisted, world.cookie.sam)).canCreateCourse).toBe(false);
  });
});
