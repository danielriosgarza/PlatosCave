import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { classes, posts, resources } from '../../src/db/schema';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/** Release time, archived classes and unknown resources for annotations and threads (§4, §8). */

const start = new Date('2026-10-01T09:00:00Z');
const releaseAt = new Date('2026-10-08T09:00:00Z');
let clock = start;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => clock,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function call(who: PersonName, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

const resourceUrl = (classId: string, resourceId = ids.samplingReading) =>
  `/api/classes/${classId}/resources/${resourceId}`;
const annotationUrl = (classId: string, id: string) => `/api/classes/${classId}/annotations/${id}`;
const note = { kind: 'note', anchor: { kind: 'none' }, body: 'Why n − 1?' };
const question = (body: string) => ({ audience: 'class', anchor: { kind: 'none' }, body });
const notified = async (who: PersonName, classId: string) => {
  const res = await call(who, 'GET', `/api/classes/${classId}/notifications`);
  expect(res.status).toBe(200);
  return res.body.items as { threadId: string; excerpt: string }[];
};

describe('unknown resources', () => {
  test('404 for a resource neither open to the caller nor carrying their marks', async () => {
    const unknown = resourceUrl(ids.classB, '00000000-0000-4000-8000-00000000dead');
    for (const who of ['bea', 'marcus'] as const) {
      expect(await call(who, 'GET', `${unknown}/annotations`)).toEqual({
        status: 404,
        body: { error: 'not found' },
      });
    }
    // A hidden resource is unknown to a student without marks on it, and open to its instructor.
    const hidden = resourceUrl(ids.classB, ids.answerKey);
    expect((await call('bea', 'GET', `${hidden}/annotations`)).status).toBe(404);
    expect((await call('marcus', 'GET', `${hidden}/annotations`)).status).toBe(200);
  });
});

describe('notification excerpts', () => {
  test('excerpts are cut on whole characters', async () => {
    const body = '𝑥'.repeat(200);
    const res = await call('marcus', 'POST', `${resourceUrl(ids.classB)}/threads`, question(body));
    expect(res.status).toBe(200);
    const item = (await notified('bea', ids.classB)).find((i) => i.threadId === res.body.id);
    expect(item?.excerpt).toBe(`${'𝑥'.repeat(139)}…`);
  });
});

describe('notification excerpts of a removed first post', () => {
  test('a deleted first post leaves no excerpt', async () => {
    const res = await call(
      'marcus',
      'POST',
      `${resourceUrl(ids.classB)}/threads`,
      question('Gone'),
    );
    expect(res.status).toBe(200);
    expect(
      (await notified('bea', ids.classB)).find((i) => i.threadId === res.body.id)?.excerpt,
    ).toBe('Gone');
    await testDb.db.update(posts).set({ deletedAt: start }).where(eq(posts.threadId, res.body.id));
    expect(
      (await notified('bea', ids.classB)).find((i) => i.threadId === res.body.id)?.excerpt,
    ).toBe('');
  });
});

describe('archived classes', () => {
  // Archives class A.
  test('an archived class refuses every annotation and thread write and keeps reads', async () => {
    const reading = resourceUrl(ids.classA);
    const mine = await call('sam', 'POST', `${reading}/annotations`, note);
    const thread = await call('priya', 'POST', `${reading}/threads`, question('Week 3.'));
    expect([mine.status, thread.status]).toEqual([200, 200]);
    await testDb.db.update(classes).set({ archivedAt: start }).where(eq(classes.id, ids.classA));

    const archived = { status: 409, body: { error: 'class_archived' } };
    const own = annotationUrl(ids.classA, mine.body.id);
    for (const who of ['sam', 'priya'] as const) {
      expect(await call(who, 'POST', `${reading}/annotations`, note)).toEqual(archived);
      expect(await call(who, 'POST', `${reading}/threads`, question('Late?'))).toEqual(archived);
    }
    expect(await call('sam', 'PUT', own, { expectedRevision: 1, body: 'Edited' })).toEqual(
      archived,
    );
    expect(await call('sam', 'PUT', own, { expectedRevision: 1, body: note.body })).toEqual(
      archived,
    );
    expect(await call('sam', 'POST', `${own}/share`, { audience: 'instructor' })).toEqual(archived);
    expect(await call('sam', 'DELETE', own)).toEqual(archived);
    const reattach = { annotationId: mine.body.id, anchor: { kind: 'none' } };
    expect(await call('sam', 'PUT', `/api/classes/${ids.classA}/placements`, reattach)).toEqual(
      archived,
    );

    expect(await call('sam', 'GET', `${reading}/annotations`)).toEqual({
      status: 200,
      body: { annotations: [mine.body], threads: [thread.body] },
    });
    expect((await notified('sam', ids.classA)).map((i) => i.threadId)).toContain(thread.body.id);
  });
});

/**
 * Publishes a release that schedules the sampling reading for `at`, and moves class B to it
 * (published releases are immutable, so a schedule change is a new release).
 */
async function scheduleInClassB(at: Date) {
  await testDb.db
    .update(resources)
    .set({ releaseAt: at })
    .where(eq(resources.id, ids.samplingReading));
  const v2 = await publishRelease(testDb.db, asCourseScope(ids.statistics, ids.elena));
  if (!v2.ok) throw new Error(JSON.stringify(v2.report));
  const adopted = await adoptRelease(
    testDb.db,
    asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: ids.releaseV1 }),
    { releaseId: v2.release.id, expectedReleaseId: ids.releaseV1 },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
}

// Last in the file: moves class B to a release that schedules the reading, and the clock on.
describe('A26 a resource scheduled for later', () => {
  test('A26 a scheduled resource takes no marks or questions from students before its release time', async () => {
    const reading = resourceUrl(ids.classB);
    // Bea marked the reading while it was open; then class B moved to a release that
    // schedules it for next week.
    const early = await call('bea', 'POST', `${reading}/annotations`, note);
    expect(early.status).toBe(200);
    await scheduleInClassB(releaseAt);

    expect((await call('bea', 'POST', `${reading}/annotations`, note)).status).toBe(404);
    expect((await call('bea', 'POST', `${reading}/threads`, question('Early?'))).status).toBe(404);
    const share = await call('bea', 'POST', `${annotationUrl(ids.classB, early.body.id)}/share`, {
      audience: 'class',
    });
    expect(share.status).toBe(404);

    // The instructor prepares a discussion before the release; students see none of it yet.
    const prepared = await call('marcus', 'POST', `${reading}/threads`, question('Read §2 first.'));
    expect(prepared.status).toBe(200);
    expect(await call('bea', 'GET', `${reading}/annotations`)).toEqual({
      status: 200,
      // Her note is kept, without a placement until the reading opens to her.
      body: { annotations: [{ ...early.body, placement: null }], threads: [] },
    });
    expect((await call('priya', 'GET', `${reading}/annotations`)).status).toBe(404);
    expect((await notified('bea', ids.classB)).map((i) => i.threadId)).not.toContain(
      prepared.body.id,
    );
    expect((await notified('priya', ids.classB)).map((i) => i.threadId)).not.toContain(
      prepared.body.id,
    );

    // At its release time the reading opens to students, with its discussion.
    clock = releaseAt;
    expect((await call('bea', 'POST', `${reading}/annotations`, note)).status).toBe(200);
    const thread = await call('bea', 'POST', `${reading}/threads`, question('Now?'));
    expect(thread.status).toBe(200);
    const margin = await call('priya', 'GET', `${reading}/annotations`);
    expect(margin.status).toBe(200);
    const open = margin.body.threads.map((t: { id: string }) => t.id);
    expect(open).toEqual(expect.arrayContaining([prepared.body.id, thread.body.id]));
    expect((await notified('priya', ids.classB)).map((i) => i.threadId)).toContain(
      prepared.body.id,
    );
  });
});
