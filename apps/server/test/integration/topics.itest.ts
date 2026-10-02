import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import type { ClassScope } from '../../src/auth/scope';
import { loadConfig } from '../../src/config';
import { findReleaseTopic, loadClassTopics } from '../../src/db/classTopics';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { classes, resourceRevisions, resources, studyPositions, topics } from '../../src/db/schema';
import { FsStorage } from '../../src/storage/fs';
import { storeCourseObject } from '../../src/storage/objects';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const nextWeek = new Date('2026-10-08T09:00:00Z');
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
});

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let root: string;
let inference: { revisionId: string; key: string };

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

interface TopicsView {
  release: { id: string; version: number } | null;
  course: { id: string; title: string };
  cohort: string;
  instructors: string[];
  topics: {
    topicId: string;
    number: number;
    title: string;
    objective: string;
    presence: Record<string, boolean>;
    firstTab: string | null;
    savedTab: string | null;
    state: string;
    availableAt: string | null;
    requires: { topicId: string; title: string }[];
  }[];
  resume: { topicId: string; tab: string; saved: boolean } | null;
  reviewed: { count: number; total: number };
}

const get = async (who: PersonName, classId: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/classes/${classId}/topics`,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
  });
  return { status: res.statusCode, body: res.json() as TopicsView };
};

const mintStatus = async (who: PersonName, classId: string, key: string, revisionId: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/classes/${classId}/resources/${revisionId}/objects/${encodeURIComponent(key)}`,
      headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
    })
  ).statusCode;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-topics-'));
  app = await buildApp(config, { db: testDb.db, storage: new FsStorage(root), now: () => now });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('topic index', () => {
  test('A02 each context lists its own cohort and instructors, and a non-member gets 404', async () => {
    const sam = await get('sam', ids.classA);
    expect(sam.status).toBe(200);
    expect(sam.body).toMatchObject({
      course: { id: ids.statistics, title: 'Statistical thinking' },
      cohort: 'Autumn 2026 A',
      instructors: ['Noor Haddad', 'Priya Nair'],
      release: { id: ids.releaseV1, version: 1 },
    });
    // Priya studies in class B and teaches class A: each side shows that class's cohort.
    const asStudent = await get('priya', ids.classB);
    expect(asStudent.body.cohort).toBe('Autumn 2026 B');
    expect(asStudent.body.instructors).toEqual(['Marcus Webb']);
    expect((await get('priya', ids.classA)).body.cohort).toBe('Autumn 2026 A');
    // Class B's preview principal is not an instructor of the cohort.
    expect((await get('previewB', ids.classB)).body.instructors).toEqual(['Marcus Webb']);

    const bea = await get('bea', ids.classA);
    expect(bea.status).toBe(404);
    expect(bea.body).toEqual({ error: 'not found' });
    expect((await get('elena', ids.classA)).status).toBe(404);
  });

  test('A02 a student sees released resources and a prerequisite lock; an instructor sees neither lock nor hidden-only gaps', async () => {
    const { body } = await get('sam', ids.classA);
    const [sampling, estimation] = body.topics;
    expect(sampling).toMatchObject({
      number: 1,
      title: 'Sampling',
      state: 'available',
      firstTab: 'reading',
      presence: { slides: false, reading: true, exercises: false, notebooks: false, tests: true },
    });
    // Estimation holds only a hidden resource: nothing to show, and it waits on Sampling.
    expect(estimation).toMatchObject({
      number: 2,
      title: 'Estimation',
      state: 'locked',
      firstTab: null,
      requires: [{ topicId: ids.sampling, title: 'Sampling' }],
      presence: { slides: false, reading: false, exercises: false, notebooks: false, tests: false },
    });
    expect(body.reviewed).toEqual({ count: 0, total: 2 });

    const teacher = (await get('priya', ids.classA)).body.topics[1];
    expect(teacher).toMatchObject({ state: 'available', requires: [], firstTab: 'reading' });
  });

  test('A03 with nothing studied yet Resume points at the first open topic, not yet saved', async () => {
    const { body } = await get('bea', ids.classB);
    expect(body.resume).toEqual({ topicId: ids.sampling, tab: 'reading', saved: false });
  });

  test('A03 the saved study position decides the resume topic and tab', async () => {
    await testDb.db.insert(studyPositions).values({
      userId: ids.sam,
      classId: ids.classA,
      resourceRevisionId: ids.samplingQuizV1,
      tab: 'tests',
      position: { question: 1 },
    });
    const { body } = await get('sam', ids.classA);
    expect(body.resume).toEqual({ topicId: ids.sampling, tab: 'tests', saved: true });
    expect(body.topics.map((t) => t.savedTab)).toEqual(['tests', null]);
    // Another student's position never leaks into this one's.
    expect((await get('priya', ids.classB)).body.resume?.saved).toBe(false);
  });
});

describe('saved tabs per topic', () => {
  test('A03 a studied topic keeps its own saved tab after the student moves to another topic', async () => {
    // Bea studies Sampling → Tests, then Sampling → Reading is older: the latest wins per topic.
    const { db } = testDb;
    const earlier = new Date('2026-10-01T08:00:00Z');
    const later = new Date('2026-10-01T08:30:00Z');
    await db.insert(studyPositions).values([
      {
        userId: ids.bea,
        classId: ids.classB,
        resourceRevisionId: ids.samplingReadingV1,
        tab: 'reading',
        position: {},
        updatedAt: earlier,
      },
      {
        userId: ids.bea,
        classId: ids.classB,
        resourceRevisionId: ids.samplingQuizV1,
        tab: 'tests',
        position: {},
        updatedAt: later,
      },
    ]);
    const { body } = await get('bea', ids.classB);
    expect(body.topics[0]?.savedTab).toBe('tests');
    expect(body.resume).toEqual({ topicId: ids.sampling, tab: 'tests', saved: true });
    // A locked topic never reports a saved tab, and nobody else's positions leak.
    expect(body.topics[1]?.savedTab).toBeNull();
    expect((await get('marcus', ids.classB)).body.topics.map((t) => t.savedTab)).toEqual([
      null,
      null,
    ]);
  });
});

describe('topic locks gate downloads', () => {
  beforeAll(async () => {
    const { db } = testDb;
    const elena = asCourseScope(ids.statistics, ids.elena);
    const addTopic = async (position: number, title: string, prerequisites: string[]) =>
      one(
        await db
          .insert(topics)
          .values({
            courseId: ids.statistics,
            position,
            title,
            prerequisites,
            createdBy: ids.elena,
          })
          .returning(),
      );
    const addPdf = async (topicId: string, title: string, bytes: string, releaseAt?: Date) => {
      const stored = await storeCourseObject(
        db,
        app.contentDeps.storage,
        elena,
        Buffer.from(bytes),
        'application/pdf',
      );
      const resource = one(
        await db
          .insert(resources)
          .values({
            courseId: ids.statistics,
            topicId,
            type: 'reading_pdf',
            title,
            position: 0,
            createdBy: ids.elena,
            ...(releaseAt && { releaseAt }),
          })
          .returning(),
      );
      const revision = one(
        await db
          .insert(resourceRevisions)
          .values({
            resourceId: resource.id,
            courseId: ids.statistics,
            type: 'reading_pdf',
            content: { title },
            accessibleAlternative: { text: title },
            objectKeys: [stored.key],
            contentHash: stored.sha256,
            createdBy: ids.elena,
          })
          .returning(),
      );
      await db
        .update(resources)
        .set({ headRevisionId: revision.id })
        .where(eq(resources.id, resource.id));
      return { revisionId: revision.id, key: stored.key };
    };

    const locked = await addTopic(2, 'Inference', [ids.sampling]);
    inference = await addPdf(locked.id, 'Inference notes', 'inference pdf');
    const scheduled = await addTopic(3, 'Bayesian methods', []);
    await addPdf(scheduled.id, 'Week 2', 'bayes pdf', nextWeek);

    const published = await publishRelease(db, elena);
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    const adopted = await adoptRelease(db, asClassScope(ids.classA, ids.statistics, ids.priya), {
      releaseId: published.release.id,
      expectedReleaseId: ids.releaseV1,
    });
    if (!adopted.ok) throw new Error(adopted.reason);
  });

  test('A02 a topic with a future release date is scheduled and shows when it opens', async () => {
    const { body } = await get('sam', ids.classA);
    const bayes = body.topics.find((t) => t.title === 'Bayesian methods');
    expect(bayes).toMatchObject({
      state: 'scheduled',
      availableAt: nextWeek.toISOString(),
      requires: [],
    });
    expect(bayes?.presence.reading).toBe(false);
    expect(bayes?.firstTab).toBeNull();
    // Class B stays on release v1 and sees neither new topic.
    expect((await get('bea', ids.classB)).body.topics.map((t) => t.title)).toEqual([
      'Sampling',
      'Estimation',
    ]);
  });

  test('A01 a student cannot mint a download for media in a prerequisite-locked topic, an instructor can', async () => {
    const { body } = await get('sam', ids.classA);
    const topic = body.topics.find((t) => t.title === 'Inference');
    expect(topic?.state).toBe('locked');
    expect(await mintStatus('sam', ids.classA, inference.key, inference.revisionId)).toBe(404);
    expect(await mintStatus('priya', ids.classA, inference.key, inference.revisionId)).toBe(200);
  });

  test('A01 the per-request topic gate agrees with the topic list for every topic and role', async () => {
    const { db } = testDb;
    const contexts = [
      [ids.classA, ids.sam, 'student', false],
      [ids.classA, ids.priya, 'instructor', false],
      [ids.classB, ids.bea, 'student', false],
      [ids.classB, ids.marcus, 'instructor', false],
      // Marcus's preview principal studies the course draft, not the adopted release.
      [ids.classB, ids.previewB, 'student', true],
    ] as const;
    let compared = 0;
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    for (const [classId, userId, role, isPreview] of contexts) {
      const [row] = await db
        .select({ releaseId: classes.releaseId })
        .from(classes)
        .where(eq(classes.id, classId));
      const scope = {
        ...asClassScope(classId, ids.statistics, userId, {
          role,
          releaseId: row?.releaseId ?? null,
        }),
        membership: { role, isPreview },
      } as unknown as ClassScope;
      const { topics: listed } = await loadClassTopics(db, scope, now);
      for (const t of listed) {
        const open = t.availability.state === 'available' || t.availability.state === 'complete';
        const byTopic = await findReleaseTopic(db, scope, { topicId: t.topicId }, now);
        const byRelease = await findReleaseTopic(
          db,
          scope,
          { releaseTopicId: t.releaseTopicId },
          now,
        );
        expect(byTopic).toEqual({ topicId: t.topicId, releaseTopicId: t.releaseTopicId, open });
        expect(byRelease).toEqual(byTopic);
        compared += 1;
      }
      expect(await findReleaseTopic(db, scope, { topicId: unknown }, now)).toBeNull();
    }
    // Class A's release and the draft hold a locked and a scheduled topic besides the open one.
    expect(compared).toBe(4 + 4 + 2 + 2 + 4);
  });
});
