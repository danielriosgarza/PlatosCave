import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import type { CourseScope } from '../../src/auth/scope';
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
import { FsStorage } from '../../src/storage/fs';
import { storeCourseObject } from '../../src/storage/objects';
import { buildWorld, ids, type World } from '../fixtures/world';
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

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

/** Appends a revision to a draft resource and moves its head, as a draft edit does. */
async function revise(resourceId: string, content: Record<string, unknown>, title?: string) {
  const { db } = testDb;
  const rev = one(
    await db
      .insert(resourceRevisions)
      .values({
        resourceId,
        courseId: ids.statistics,
        type: 'test',
        content,
        contentHash: JSON.stringify(content),
        createdBy: ids.elena,
      })
      .returning(),
  );
  await db
    .update(resources)
    .set({
      headRevisionId: rev.id,
      revision: sql`${resources.revision} + 1`,
      ...(title && { title }),
    })
    .where(eq(resources.id, resourceId));
  return rev;
}

/** A draft topic holding one test resource with a first revision. */
async function draft(content: Record<string, unknown>) {
  const { db } = testDb;
  const topic = one(
    await db
      .insert(topics)
      .values({ courseId: ids.statistics, position: 0, title: 'Sampling', createdBy: ids.elena })
      .returning(),
  );
  const resource = one(
    await db
      .insert(resources)
      .values({
        courseId: ids.statistics,
        topicId: topic.id,
        type: 'test',
        title: 'Quiz',
        position: 0,
        createdBy: ids.elena,
      })
      .returning(),
  );
  const revision = await revise(resource.id, content);
  return { topic, resource, revision };
}

/** Snapshot of the drafts, as P1-05's publish will write it, adopted by class A. */
async function publishAndAdopt(
  topicId: string,
  resourceId: string,
  revisionId: string,
  version: number,
) {
  const { db } = testDb;
  const release = one(
    await db
      .insert(courseReleases)
      .values({ courseId: ids.statistics, version, createdBy: ids.elena })
      .returning(),
  );
  const releaseTopic = one(
    await db
      .insert(releaseTopics)
      .values({
        releaseId: release.id,
        topicId,
        position: 0,
        title: 'Sampling',
        objective: '',
        prerequisites: [],
      })
      .returning(),
  );
  const releaseResource = one(
    await db
      .insert(releaseResources)
      .values({
        releaseId: release.id,
        releaseTopicId: releaseTopic.id,
        resourceId,
        resourceRevisionId: revisionId,
        tab: 'tests',
        position: 0,
        title: 'Quiz',
        visibility: 'visible',
      })
      .returning(),
  );
  await db.update(classes).set({ releaseId: release.id }).where(eq(classes.id, ids.classA));
  return { release, releaseTopic, releaseResource };
}

/** Postgres error raised by a statement, unwrapped from drizzle's query error. */
async function pgError(run: () => Promise<unknown>): Promise<{ code?: string }> {
  try {
    await run();
  } catch (err) {
    const e = err as { cause?: { code?: string }; code?: string };
    return e.cause ?? e;
  }
  throw new Error('statement unexpectedly succeeded');
}

const classView = async (classId: string, cookie: string) =>
  (await app.inject({ method: 'GET', url: `/api/classes/${classId}`, headers: { cookie } })).json();

describe('content releases and revisions', () => {
  test('A26 editing drafts never changes what a class route reads: the adopted release stays pinned', async () => {
    const { topic, resource, revision } = await draft({ question: 'v1' });
    const { release, releaseResource } = await publishAndAdopt(
      topic.id,
      resource.id,
      revision.id,
      2,
    );

    await revise(resource.id, { question: 'draft v2' }, 'Quiz, revised');
    await testDb.db.update(topics).set({ title: 'Draft title' }).where(eq(topics.id, topic.id));

    expect((await classView(ids.classA, world.cookie.sam)).releaseId).toBe(release.id);
    const pinned = await testDb.db
      .select({ title: releaseResources.title, content: resourceRevisions.content })
      .from(releaseResources)
      .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
      .where(eq(releaseResources.releaseId, release.id));
    expect(pinned).toEqual([{ title: 'Quiz', content: { question: 'v1' } }]);
    expect(releaseResource.resourceRevisionId).toBe(revision.id);
    // Class B stays on the release it adopted: class A's adoption and the drafts do not reach it.
    expect((await classView(ids.classB, world.cookie.bea)).releaseId).toBe(ids.releaseV1);
  });

  test('A16 a pinned revision keeps its original content; releases and revisions reject changes', async () => {
    const { topic, resource, revision } = await draft({ question: 'original', grader: 1 });
    const { release, releaseTopic, releaseResource } = await publishAndAdopt(
      topic.id,
      resource.id,
      revision.id,
      3,
    );
    const changed = await revise(resource.id, { question: 'changed', grader: 2 });
    const { db } = testDb;
    const contentOf = async (id: string) =>
      one(await db.select().from(resourceRevisions).where(eq(resourceRevisions.id, id)));

    const attempts = [
      () =>
        db
          .update(resourceRevisions)
          .set({ content: {} })
          .where(eq(resourceRevisions.id, revision.id)),
      () =>
        db
          .update(resourceRevisions)
          .set({ contentHash: 'x' })
          .where(eq(resourceRevisions.id, revision.id)),
      () => db.delete(resourceRevisions).where(eq(resourceRevisions.id, revision.id)),
      () => db.update(courseReleases).set({ version: 99 }).where(eq(courseReleases.id, release.id)),
      () => db.delete(courseReleases).where(eq(courseReleases.id, release.id)),
      () =>
        db.update(releaseTopics).set({ title: 'x' }).where(eq(releaseTopics.id, releaseTopic.id)),
      () =>
        db
          .update(releaseResources)
          .set({ resourceRevisionId: changed.id })
          .where(eq(releaseResources.id, releaseResource.id)),
      () => db.delete(releaseResources).where(eq(releaseResources.id, releaseResource.id)),
      () => db.execute(sql`truncate release_resources`),
    ];
    for (const run of attempts) {
      // 23000: the immutability triggers; 23503: foreign keys keep referenced revisions alive.
      expect(['23000', '23503']).toContain((await pgError(run)).code);
    }
    expect((await contentOf(revision.id)).content).toEqual({ question: 'original', grader: 1 });
    expect(
      one(
        await db.select().from(releaseResources).where(eq(releaseResources.id, releaseResource.id)),
      ),
    ).toMatchObject({ resourceRevisionId: revision.id });

    // Conversion jobs may still record derived outputs on an existing revision.
    const status = {
      state: 'ready',
      job: 'slides.convert',
      jobId: null,
      updatedAt: '2026-10-01T09:00:00.000Z',
    };
    await db
      .update(resourceRevisions)
      .set({ derived: { status } })
      .where(eq(resourceRevisions.id, revision.id));
    expect((await contentOf(revision.id)).derived).toEqual({ status });
  });

  test('a class can only adopt a release of its own course; resources stay in their topic’s course', async () => {
    const { db } = testDb;
    const foreign = one(
      await db
        .insert(courseReleases)
        .values({ courseId: ids.linearModels, version: 1, createdBy: ids.olivia })
        .returning(),
    );
    const adopt = () =>
      db.update(classes).set({ releaseId: foreign.id }).where(eq(classes.id, ids.classB));
    expect((await pgError(adopt)).code).toBe('23503');

    const { topic } = await draft({});
    const crossCourse = () =>
      db.insert(resources).values({
        courseId: ids.linearModels,
        topicId: topic.id,
        type: 'reading_native',
        title: 'x',
        position: 0,
        createdBy: ids.olivia,
      });
    expect((await pgError(crossCourse)).code).toBe('23503');
  });

  test('course objects are stored once under content-addressed keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'parallax-objects-'));
    try {
      const storage = new FsStorage(root);
      const scope = { courseId: ids.statistics, user: { id: ids.elena } } as unknown as CourseScope;
      const put = () =>
        storeCourseObject(testDb.db, storage, scope, Buffer.from('%PDF'), 'application/pdf');
      const a = await put();
      const b = await put();
      expect(b.key).toBe(a.key);
      expect(a.key).toBe(`courses/${ids.statistics}/objects/${a.sha256}`);
      const rows = await testDb.db
        .select()
        .from(storageObjects)
        .where(eq(storageObjects.key, a.key));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        size: 4,
        contentType: 'application/pdf',
        createdBy: ids.elena,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
