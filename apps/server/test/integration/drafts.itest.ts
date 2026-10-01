import { updateResource, updateTopic } from '@parallax/contracts/routes/drafts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import {
  classes,
  courseReleases,
  releaseResources,
  releaseTopics,
  resourceRevisions,
  resources,
  storageObjects,
  topics,
} from '../../src/db/schema';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const course = `/api/courses/${ids.statistics}`;

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

async function call(who: PersonName, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: world.cookie[who] },
    ...(body && { payload: body }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function newTopic(title = 'Sampling') {
  const res = await call('elena', 'POST', `${course}/topics`, { title });
  expect(res.status).toBe(200);
  return res.body as { id: string; revision: number; position: number };
}

async function newResource(topicId: string, content: Record<string, unknown> = { q: 'v1' }) {
  const res = await call('elena', 'POST', `${course}/topics/${topicId}/resources`, {
    type: 'test',
    title: 'Quiz',
    content,
  });
  expect(res.status).toBe(200);
  return res.body as { id: string; revision: number; headRevisionId: string };
}

const revisionsOf = (resourceId: string) =>
  testDb.db.select().from(resourceRevisions).where(eq(resourceRevisions.resourceId, resourceId));

describe('draft editing API', () => {
  test('A26 class members without a course grant get 404 on every draft route', async () => {
    const topic = await newTopic();
    const resource = await newResource(topic.id);
    const routes: [string, string, object?][] = [
      ['GET', `${course}/drafts`],
      ['POST', `${course}/topics`, { title: 'x' }],
      ['PATCH', `${course}/topics/${topic.id}`, { expectedRevision: 1, title: 'x' }],
      ['POST', `${course}/topics/${topic.id}/resources`, { type: 'test', title: 'x' }],
      ['GET', `${course}/resources/${resource.id}`],
      ['PATCH', `${course}/resources/${resource.id}`, { expectedRevision: 1, title: 'x' }],
    ];
    // Sam and Bea study in the course's classes; Olivia owns another course; previewB is a
    // preview principal. None holds a grant on Statistical thinking.
    for (const who of ['sam', 'bea', 'olivia', 'previewB'] as const) {
      for (const [method, url, body] of routes) {
        const res = await call(who, method as 'GET', url, body);
        expect([who, method, url, res.status]).toEqual([who, method, url, 404]);
        expect(res.body).toEqual({ error: 'not found' });
      }
    }
    // Nothing changed for the refused writes.
    const stored = await testDb.db.select().from(topics).where(eq(topics.id, topic.id));
    expect(stored[0]).toMatchObject({ title: 'Sampling', revision: 1 });

    // A topic or resource of another course looks exactly like one that does not exist.
    const foreign = await call('olivia', 'POST', `/api/courses/${ids.linearModels}/topics`, {
      title: 'Least squares',
    });
    for (const url of [
      `${course}/topics/${foreign.body.id}/resources`,
      `${course}/topics/00000000-0000-4000-8000-999999999999/resources`,
    ]) {
      const res = await call('elena', 'POST', url, { type: 'test', title: 'x' });
      expect(res).toEqual({ status: 404, body: { error: 'not found' } });
    }
    const moved = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      topicId: foreign.body.id,
    });
    expect(moved).toEqual({ status: 404, body: { error: 'not found' } });
  });

  test('A26 editing drafts through the API never changes the adopted release', async () => {
    const topic = await newTopic('Confidence intervals');
    const resource = await newResource(topic.id, { q: 'published' });
    const { db } = testDb;
    const [release] = await db
      .insert(courseReleases)
      .values({ courseId: ids.statistics, version: 1, createdBy: ids.elena })
      .returning();
    if (!release) throw new Error('no release');
    const [releaseTopic] = await db
      .insert(releaseTopics)
      .values({
        releaseId: release.id,
        topicId: topic.id,
        position: 0,
        title: 'Confidence intervals',
        objective: '',
        prerequisites: [],
      })
      .returning();
    if (!releaseTopic) throw new Error('no release topic');
    await db.insert(releaseResources).values({
      releaseId: release.id,
      releaseTopicId: releaseTopic.id,
      resourceId: resource.id,
      resourceRevisionId: resource.headRevisionId,
      tab: 'tests',
      position: 0,
      title: 'Quiz',
      visibility: 'visible',
    });
    await db.update(classes).set({ releaseId: release.id }).where(eq(classes.id, ids.classA));

    // Marcus holds the editor grant through teaching class B.
    const edited = await call('marcus', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      title: 'Quiz, revised',
      content: { q: 'draft edit' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.headRevisionId).not.toBe(resource.headRevisionId);
    const renamed = await call('elena', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: 1,
      title: 'Draft title',
      archived: true,
    });
    expect(renamed.status).toBe(200);

    const view = await call('sam', 'GET', `/api/classes/${ids.classA}`);
    expect(view.body.releaseId).toBe(release.id);
    const pinned = await db
      .select({
        title: releaseResources.title,
        revisionId: releaseResources.resourceRevisionId,
        content: resourceRevisions.content,
        topicTitle: releaseTopics.title,
      })
      .from(releaseResources)
      .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
      .innerJoin(releaseTopics, eq(releaseTopics.id, releaseResources.releaseTopicId))
      .where(eq(releaseResources.releaseId, release.id));
    expect(pinned).toEqual([
      {
        title: 'Quiz',
        revisionId: resource.headRevisionId,
        content: { q: 'published' },
        topicTitle: 'Confidence intervals',
      },
    ]);
    const releases = await db
      .select()
      .from(courseReleases)
      .where(eq(courseReleases.courseId, ids.statistics));
    expect(releases).toHaveLength(1);
    expect((await call('bea', 'GET', `/api/classes/${ids.classB}`)).body.releaseId).toBeNull();
  });

  test('a stale expectedRevision gets 409 with the server copy and overwrites nothing', async () => {
    const topic = await newTopic('Hypothesis tests');
    const first = await call('elena', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: 1,
      objective: 'State a null hypothesis',
    });
    expect(first.body).toMatchObject({ revision: 2, objective: 'State a null hypothesis' });
    const stale = await call('marcus', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: 1,
      objective: 'Something else',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'revision_conflict', current: first.body });
    expect(updateTopic.errors?.[409].safeParse(stale.body).success).toBe(true);

    const resource = await newResource(topic.id, { q: 'one' });
    const saved = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      content: { q: 'two' },
    });
    expect(saved.status).toBe(200);
    const conflict = await call('marcus', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      content: { q: 'three' },
      title: 'Overwrite',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'revision_conflict', current: saved.body });
    expect(conflict.body.current.head.content).toEqual({ q: 'two' });
    expect(updateResource.errors?.[409].safeParse(conflict.body).success).toBe(true);
    expect(await revisionsOf(resource.id)).toHaveLength(2);

    // Concurrent saves from the same revision: exactly one wins.
    const race = await Promise.all(
      (['elena', 'marcus', 'priya'] as const).map((who, i) =>
        call(who, 'PATCH', `${course}/resources/${resource.id}`, {
          expectedRevision: 2,
          content: { q: `race ${i}` },
        }),
      ),
    );
    expect(race.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await revisionsOf(resource.id)).toHaveLength(3);
  });

  test('a content change adds a revision and moves the head; unchanged content keeps it', async () => {
    const topic = await newTopic('Regression');
    const resource = await newResource(topic.id, { b: 1, a: { y: 2, x: 1 } });
    expect(await revisionsOf(resource.id)).toHaveLength(1);

    // Same content with keys in another order is the same content.
    const same = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      content: { a: { x: 1, y: 2 }, b: 1 },
      title: 'Renamed quiz',
    });
    expect(same.body).toMatchObject({
      revision: 2,
      title: 'Renamed quiz',
      headRevisionId: resource.headRevisionId,
    });
    expect(await revisionsOf(resource.id)).toHaveLength(1);

    const changed = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 2,
      content: { a: { x: 1, y: 3 }, b: 1 },
    });
    expect(changed.body.revision).toBe(3);
    expect(changed.body.headRevisionId).not.toBe(resource.headRevisionId);
    expect(changed.body.head).toMatchObject({
      id: changed.body.headRevisionId,
      content: { a: { x: 1, y: 3 }, b: 1 },
      createdBy: ids.elena,
    });

    // An accessible alternative is part of the revision, so adding one is a content change.
    const alt = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 3,
      accessibleAlternative: { text: 'Plain-text version' },
    });
    expect(alt.body.head).toMatchObject({
      content: { a: { x: 1, y: 3 }, b: 1 },
      accessibleAlternative: { text: 'Plain-text version' },
    });
    const all = await revisionsOf(resource.id);
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.id === resource.headRevisionId)?.content).toEqual({
      b: 1,
      a: { y: 2, x: 1 },
    });

    const read = await call('marcus', 'GET', `${course}/resources/${resource.id}`);
    expect(read).toEqual({ status: 200, body: alt.body });
  });

  test('a resource created without content has no head until its first content save', async () => {
    const topic = await newTopic('Bootstrap');
    const empty = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_native',
      title: 'Resampling',
    });
    expect(empty.body).toMatchObject({ headRevisionId: null, head: null, revision: 1 });
    const titled = await call('elena', 'PATCH', `${course}/resources/${empty.body.id}`, {
      expectedRevision: 1,
      provenance: { source: 'lecture notes' },
    });
    expect(titled.status).toBe(400);
    const filled = await call('elena', 'PATCH', `${course}/resources/${empty.body.id}`, {
      expectedRevision: 1,
      content: { markdown: '# Resampling' },
    });
    expect(filled.body.head).toMatchObject({ content: { markdown: '# Resampling' } });
  });

  test('archive and restore replace deletion and keep every row', async () => {
    const topic = await newTopic('Archived topic');
    const resource = await newResource(topic.id);
    const archived = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 1,
      archived: true,
    });
    expect(archived.body).toMatchObject({ archived: true, revision: 2 });
    const topicArchived = await call('elena', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: 1,
      archived: true,
    });
    expect(topicArchived.body.archived).toBe(true);

    const list = await call('priya', 'GET', `${course}/drafts`);
    const listed = list.body.topics.find((t: { id: string }) => t.id === topic.id);
    expect(listed).toMatchObject({
      archived: true,
      resources: [{ id: resource.id, archived: true }],
    });

    const restored = await call('elena', 'PATCH', `${course}/resources/${resource.id}`, {
      expectedRevision: 2,
      archived: false,
    });
    expect(restored.body).toMatchObject({
      archived: false,
      headRevisionId: resource.headRevisionId,
    });
    const topicRestored = await call('elena', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: 2,
      archived: false,
    });
    expect(topicRestored.body.archived).toBe(false);
    expect(await revisionsOf(resource.id)).toHaveLength(1);
  });

  test('drafts list topics and resources in position order', async () => {
    const res = await call('olivia', 'GET', `/api/courses/${ids.linearModels}/drafts`);
    const before = res.body.topics.length;
    const base = `/api/courses/${ids.linearModels}`;
    const a = await call('olivia', 'POST', `${base}/topics`, { title: 'A' });
    const b = await call('olivia', 'POST', `${base}/topics`, { title: 'B', position: 0 });
    expect(a.body.position).toBe(before);
    const r1 = await call('olivia', 'POST', `${base}/topics/${a.body.id}/resources`, {
      type: 'slides_pdf',
      title: 'Deck',
    });
    const r2 = await call('olivia', 'POST', `${base}/topics/${a.body.id}/resources`, {
      type: 'reading_native',
      title: 'Notes',
    });
    expect([r1.body.position, r2.body.position]).toEqual([0, 1]);
    const list = await call('olivia', 'GET', `${base}/drafts`);
    const titles = list.body.topics.map((t: { title: string }) => t.title);
    expect(titles.indexOf('B')).toBeLessThan(titles.indexOf('A'));
    const topicA = list.body.topics.find((t: { id: string }) => t.id === a.body.id);
    expect(topicA.resources.map((r: { title: string }) => r.title)).toEqual(['Deck', 'Notes']);
    expect(b.status).toBe(200);
  });

  test('object keys must name objects stored in the same course', async () => {
    const { db } = testDb;
    const own = `courses/${ids.statistics}/objects/${'a'.repeat(64)}`;
    const foreign = `courses/${ids.linearModels}/objects/${'b'.repeat(64)}`;
    await db.insert(storageObjects).values([
      { courseId: ids.statistics, key: own, sha256: 'a'.repeat(64), size: 1, contentType: 'x' },
      {
        courseId: ids.linearModels,
        key: foreign,
        sha256: 'b'.repeat(64),
        size: 1,
        contentType: 'x',
      },
    ]);
    const topic = await newTopic('Objects');
    const bad = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_pdf',
      title: 'Paper',
      content: {},
      objectKeys: [foreign],
    });
    expect(bad.status).toBe(400);
    const ok = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_pdf',
      title: 'Paper',
      content: {},
      objectKeys: [own],
    });
    expect(ok.body.head.objectKeys).toEqual([own]);
    const rows = await db.select().from(resources).where(eq(resources.topicId, topic.id));
    expect(rows).toHaveLength(1);
  });
});
