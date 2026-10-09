import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { studyPositions } from '../../src/db/schema';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => now,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

const get = async (who: PersonName) => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/courses',
    headers: { cookie: world.cookie[who] },
  });
  return { status: res.statusCode, body: res.json() };
};

describe('GET /api/courses', () => {
  test('A02 a student lists only the class they study in, without instructor data', async () => {
    const { status, body } = await get('sam');
    expect(status).toBe(200);
    expect(body.courses).toEqual([]);
    expect(body.classes).toEqual([
      expect.objectContaining({
        classId: ids.classA,
        courseTitle: 'Statistical thinking',
        role: 'student',
        archived: false,
        topicCount: 2,
        reviewed: { count: 0, total: 2 },
        resume: null,
        studentCount: null,
      }),
    ]);
  });

  test('A02 a person who teaches one class and studies in another gets each role on its own card', async () => {
    const { body } = await get('priya');
    const byClass = Object.fromEntries(
      body.classes.map((c: { classId: string; role: string }) => [c.classId, c]),
    );
    expect(Object.keys(byClass).sort()).toEqual([ids.classA, ids.classB]);
    expect(byClass[ids.classA]).toMatchObject({
      role: 'instructor',
      studentCount: 1,
      resume: null,
    });
    expect(byClass[ids.classB]).toMatchObject({ role: 'student', studentCount: null });
    // Priya holds editor on the course because she teaches class A.
    expect(body.courses).toEqual([
      expect.objectContaining({ courseId: ids.statistics, editor: true, owner: false }),
    ]);
  });

  test('A02 an owner without a class membership lists the course, not other courses', async () => {
    const { body } = await get('elena');
    expect(body.classes).toEqual([]);
    expect(body.courses).toEqual([
      expect.objectContaining({
        courseId: ids.statistics,
        owner: true,
        topicCount: 2,
        classCount: 2,
        archived: false,
      }),
    ]);
    expect((await get('olivia')).body.courses).toEqual([
      expect.objectContaining({ courseId: ids.linearModels, topicCount: 0, classCount: 0 }),
    ]);
  });

  test('A02 a preview principal is not a context of the instructor who owns it', async () => {
    const { body } = await get('marcus');
    expect(body.classes.map((c: { classId: string }) => c.classId)).toEqual([ids.classB]);
    expect(body.classes[0]).toMatchObject({ role: 'instructor', studentCount: 2 });
  });

  test('A02 the resume location is the newest saved position inside the adopted release', async () => {
    await testDb.db.insert(studyPositions).values([
      {
        userId: ids.sam,
        classId: ids.classA,
        resourceRevisionId: ids.samplingQuizV1,
        tab: 'tests',
        position: {},
        updatedAt: new Date('2026-09-30T09:00:00Z'),
      },
      {
        userId: ids.sam,
        classId: ids.classA,
        resourceRevisionId: ids.samplingReadingV1,
        tab: 'reading',
        position: { page: 2 },
        updatedAt: new Date('2026-10-01T08:00:00Z'),
      },
    ]);
    const { body } = await get('sam');
    expect(body.classes[0].resume).toEqual({
      topicId: ids.sampling,
      topicTitle: 'Sampling',
      tab: 'reading',
      resourceTitle: 'Why samples vary',
    });
    // Positions are personal: a classmate sees none.
    expect(
      (await get('bea')).body.classes.every((c: { resume: unknown }) => c.resume === null),
    ).toBe(true);
  });

  test('A02 a saved position on a hidden resource is never offered as the resume location', async () => {
    // The answer key is hidden in release v1; a position saved before it was hidden remains.
    await testDb.db.insert(studyPositions).values([
      {
        userId: ids.sam,
        classId: ids.classA,
        resourceRevisionId: ids.answerKeyV1,
        tab: 'reading',
        position: {},
        updatedAt: new Date('2026-10-01T08:30:00Z'),
      },
      {
        userId: ids.bea,
        classId: ids.classB,
        resourceRevisionId: ids.answerKeyV1,
        tab: 'reading',
        position: {},
        updatedAt: new Date('2026-10-01T08:30:00Z'),
      },
    ]);
    const sam = await get('sam');
    // Newest position is the hidden one: the card falls back to the newest visible one.
    expect(sam.body.classes[0].resume).toMatchObject({ resourceTitle: 'Why samples vary' });
    expect(JSON.stringify(sam.body)).not.toContain('Answer key');
    // With only a hidden position, there is nothing to resume.
    const bea = await get('bea');
    expect(bea.body.classes[0].resume).toBeNull();
    expect(JSON.stringify(bea.body)).not.toContain('Answer key');
  });

  test('A02 signed-out requests are refused', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/courses' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/courses', () => {
  const create = (who: PersonName, title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/courses',
      headers: { cookie: world.cookie[who] },
      payload: { title },
    });

  test('A02 an instructor creates a course and becomes its owner', async () => {
    const res = await create('marcus', 'Bayesian methods');
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created.title).toBe('Bayesian methods');
    const { body } = await get('marcus');
    expect(body.courses).toEqual([
      expect.objectContaining({ courseId: created.id, owner: true, editor: true, publisher: true }),
      expect.objectContaining({ courseId: ids.statistics, owner: false, editor: true }),
    ]);
  });

  test('A02 an account that teaches nothing cannot create a course', async () => {
    const res = await create('sam', 'Nope');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_instructor' });
    expect((await get('sam')).body.courses).toEqual([]);
  });
});
