import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CourseScope, resolveActorScope } from '../../src/auth/scope';
import { normaliseText } from '../../src/content/reading';
import { resourceRevisions, resources, topics } from '../../src/db/schema';
import { createBoss } from '../../src/jobs/boss';
import readingIngest, { enqueueReadingIngest } from '../../src/jobs/reading-ingest.job';
import { loadJobs } from '../../src/jobs/registry';
import { runScopedJob, type ScopedPayload, workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { storeCourseObject } from '../../src/storage/objects';
import type { Storage } from '../../src/storage/storage';
import { makePdf } from '../fixtures/pdf';
import { buildWorld, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

let testDb: TestDatabase;
let boss: PgBoss;
let root: string;
let storage: FsStorage;
let elena: CourseScope;
let topicId: string;
const bossErrors: Error[] = [];

async function courseScope(actorId: string, courseId: string): Promise<CourseScope> {
  const resolution = await resolveActorScope(
    testDb.db,
    actorId,
    { kind: 'course', role: 'editor' },
    courseId,
  );
  if (!resolution.ok) throw new Error(resolution.reason);
  return resolution.scope as CourseScope;
}

let position = 0;
/** A reading resource with one revision in Statistical thinking. */
async function revision(
  type: 'reading_native' | 'reading_pdf',
  content: Record<string, unknown>,
  objectKeys: string[] = [],
): Promise<string> {
  const { db } = testDb;
  const [resource] = await db
    .insert(resources)
    .values({
      courseId: ids.statistics,
      topicId,
      type,
      title: `Reading ${position}`,
      position: position++,
      createdBy: ids.elena,
    })
    .returning();
  if (!resource) throw new Error('no resource');
  const [row] = await db
    .insert(resourceRevisions)
    .values({
      resourceId: resource.id,
      courseId: ids.statistics,
      type,
      content,
      objectKeys,
      contentHash: `h${position}`,
      createdBy: ids.elena,
    })
    .returning();
  if (!row) throw new Error('no revision');
  return row.id;
}

const derivedOf = async (revisionId: string) => {
  const [row] = await testDb.db
    .select({ derived: resourceRevisions.derived })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId));
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the stored JSON freely.
  return row?.derived as Record<string, any>;
};

/** Polls until the revision's ingestion settles; the worker polls every half second. */
async function settled(revisionId: string) {
  for (let i = 0; i < 60; i++) {
    const derived = await derivedOf(revisionId);
    if (derived?.status?.state === 'ready' || derived?.status?.state === 'failed') return derived;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`revision ${revisionId} did not settle`);
}

const fakeJob = (
  revisionId: string,
  retryCount: number,
  retryLimit?: number,
): Job<unknown> & { retryLimit?: number } => ({
  id: '00000000-0000-4000-8000-00000000beef',
  name: readingIngest.name,
  data: {
    actorId: ids.elena,
    scope: { kind: 'course', courseId: ids.statistics },
    input: { revisionId },
  } satisfies ScopedPayload,
  expireInSeconds: 60,
  heartbeatSeconds: null,
  retryCount,
  ...(retryLimit !== undefined && { retryLimit }),
  signal: new AbortController().signal,
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db);
  root = await mkdtemp(join(tmpdir(), 'parallax-ingest-'));
  storage = new FsStorage(root);
  elena = await courseScope(ids.elena, ids.statistics);
  const [topic] = await testDb.db
    .insert(topics)
    .values({ courseId: ids.statistics, position: 9, title: 'Ingest', createdBy: ids.elena })
    .returning();
  if (!topic) throw new Error('no topic');
  topicId = topic.id;
  boss = createBoss(testDb.db.$client, {
    role: 'api',
    onError: (err) => bossErrors.push(err),
    onWarning: () => {},
  });
  await boss.start();
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('reading.ingest', () => {
  test('the worker discovers reading.ingest among the real job modules', async () => {
    expect((await loadJobs()).map((job) => job.name)).toContain(readingIngest.name);
  });

  test('A06 an uploaded Markdown reading is ingested by the worker with block ids and images', async () => {
    // Sent before any worker exists: the enqueue creates the queue (pg-boss refuses otherwise).
    const source = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      Buffer.from('# Sampling\n\nEvery sample differs.\n\n![Means](means.png "Means")\n'),
      'text/markdown',
    );
    const image = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      Buffer.from('png'),
      'image/png',
    );
    const revisionId = await revision(
      'reading_native',
      { sourceKey: source.key, format: 'markdown', assets: { 'means.png': image.key } },
      [source.key, image.key],
    );
    const jobId = await enqueueReadingIngest(boss, testDb.db, elena, revisionId);
    expect(jobId).toEqual(expect.any(String));
    expect(await boss.getQueue(readingIngest.name)).toMatchObject({
      retryLimit: 2,
      retryBackoff: true,
    });
    expect((await derivedOf(revisionId)).status).toMatchObject({
      state: 'queued',
      job: 'reading.ingest',
    });

    await workScopedJob(
      boss,
      testDb.db,
      readingIngest,
      { warn: () => {}, error: () => {} },
      { pollingIntervalSeconds: 0.5 },
      { storage },
    );
    const derived = await settled(revisionId);
    expect(derived.status).toMatchObject({ state: 'ready', jobId });
    expect(derived.blockMap.map((b: { text: string }) => normaliseText(b.text))).toEqual([
      'Sampling',
      'Every sample differs.',
      'Means',
    ]);
    expect(derived.html).toContain(
      `data-block-id="${derived.blockMap[1].id}">Every sample differs.</p>`,
    );
    expect(derived.html).toContain(`data-object-key="${image.key}"`);
    expect(derived.figures).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{12}$/),
        objectKey: image.key,
        alt: 'Means',
        caption: 'Means',
      },
    ]);
    expect(derived.warnings).toEqual([]);
    expect(bossErrors).toEqual([]);
  });

  test('A06 a PDF reading records its page count and per-page text', async () => {
    const pdf = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      makePdf(['One', 'Two', 'Three']),
      'application/pdf',
    );
    const revisionId = await revision('reading_pdf', {}, [pdf.key]);
    await enqueueReadingIngest(boss, testDb.db, elena, revisionId);
    const derived = await settled(revisionId);
    expect(derived.status.state).toBe('ready');
    expect(derived.pageCount).toBe(3);
    expect(derived.pages.map((p: { text: string }) => p.text)).toEqual(['One', 'Two', 'Three']);
  });

  test('a reading that cannot be ingested fails at once with the reason, without retries', async () => {
    const revisionId = await revision('reading_native', {
      sourceKey: 'courses/elsewhere/objects/x',
      format: 'html',
    });
    await enqueueReadingIngest(boss, testDb.db, elena, revisionId);
    const derived = await settled(revisionId);
    expect(derived.status).toMatchObject({
      state: 'failed',
      error: 'The file is not part of this reading',
    });
    // An uploaded file missing from the store is final as well: retrying cannot bring it back.
    const gone = 'courses/00000000-0000-4000-8000-000000000101/objects/0000';
    const missing = await revision('reading_pdf', { objectKey: gone }, [gone]);
    await enqueueReadingIngest(boss, testDb.db, elena, missing);
    expect((await settled(missing)).status).toMatchObject({
      state: 'failed',
      error: 'The uploaded file is no longer available; upload it again',
    });
  });

  test('a queue that cannot be created leaves the revision failed, not queued', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Queue' });
    const broken = {
      createQueue: async () => {
        throw new Error('advisory lock timeout');
      },
    } as unknown as PgBoss;
    await expect(enqueueReadingIngest(broken, testDb.db, elena, revisionId)).rejects.toThrow(
      'advisory lock timeout',
    );
    expect((await derivedOf(revisionId)).status).toMatchObject({
      state: 'failed',
      error: 'Could not queue processing',
    });
  });

  test('derived.status retry: a failing attempt shows queued with the error, the last one failed', async () => {
    const pdf = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      makePdf(['Retry']),
      'application/pdf',
    );
    const revisionId = await revision('reading_pdf', { objectKey: pdf.key }, [pdf.key]);
    const broken: Storage = {
      ...storage,
      put: storage.put.bind(storage),
      head: storage.head.bind(storage),
      delete: storage.delete.bind(storage),
      get: async () => {
        throw new Error('backend unavailable at /internal/path');
      },
    };
    const attempt = (retryCount: number, store: Storage, retryLimit?: number) =>
      runScopedJob(testDb.db, readingIngest, fakeJob(revisionId, retryCount, retryLimit), {
        storage: store,
      });

    await expect(attempt(0, broken)).rejects.toThrow('backend unavailable');
    expect((await derivedOf(revisionId)).status).toMatchObject({
      state: 'queued',
      error: 'Attempt 1 could not finish; trying again',
    });
    // The limit pg-boss reports for the job wins over the queue default of 2.
    await expect(attempt(2, broken, 5)).rejects.toThrow('backend unavailable');
    expect((await derivedOf(revisionId)).status).toMatchObject({
      state: 'queued',
      error: 'Attempt 3 could not finish; trying again',
    });
    await expect(attempt(2, broken, 2)).rejects.toThrow('backend unavailable');
    const failed = (await derivedOf(revisionId)).status;
    expect(failed.state).toBe('failed');
    // Internal error details stay in the logs, not in what editors see.
    expect(failed.error).not.toContain('/internal/path');

    // Retrying after the failure (enqueuing again, as an editor's Retry will) succeeds.
    await enqueueReadingIngest(boss, testDb.db, elena, revisionId);
    expect(await settled(revisionId)).toMatchObject({ status: { state: 'ready' }, pageCount: 1 });
  });

  test('another course cannot enqueue or ingest this course’s revisions', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Private' });
    const olivia = await courseScope(ids.olivia, ids.linearModels);
    expect(await enqueueReadingIngest(boss, testDb.db, olivia, revisionId)).toBeNull();
    expect((await derivedOf(revisionId)).status).toBeUndefined();

    const foreign = {
      ...fakeJob(revisionId, 0),
      data: {
        actorId: ids.olivia,
        scope: { kind: 'course', courseId: ids.linearModels },
        input: { revisionId },
      },
    };
    expect(await runScopedJob(testDb.db, readingIngest, foreign, { storage })).toEqual({
      status: 'completed',
      output: { failed: 'revision not found in this course' },
    });
    expect((await derivedOf(revisionId)).status).toBeUndefined();
  });
});
