import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CourseScope, resolveActorScope } from '../../src/auth/scope';
import { normaliseText } from '../../src/content/reading';
import { createBoss } from '../../src/db/jobs/boss';
import { listResourceJobStatus, readStatus, setDerivedStatus } from '../../src/db/jobs/derived';
import { resourceRevisions, resources, topics } from '../../src/db/schema';
import readingIngest, {
  enqueueIfUnprocessed,
  enqueueReadingIngest,
} from '../../src/jobs/reading-ingest.job';
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
  type: 'reading_native' | 'reading_pdf' | 'slides_pdf' | 'slides_web',
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
  signal: AbortSignal = new AbortController().signal,
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
  signal,
});

const OTHER_JOB = '00000000-0000-4000-8000-00000000f00d';
const statusFor = (jobId: string | null) => ({
  state: 'queued' as const,
  job: readingIngest.name,
  jobId,
  updatedAt: new Date().toISOString(),
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

/** Queues as an editor does: against the status just read (Retry, or a save with no status). */
const enqueue = async (b: PgBoss, scope: CourseScope, revisionId: string) =>
  enqueueReadingIngest(b, testDb.db, scope, revisionId, {
    tag: (await readStatus(testDb.db, scope, revisionId))?.tag ?? null,
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
    const jobId = await enqueue(boss, elena, revisionId);
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
      { info: () => {}, warn: () => {}, error: () => {} },
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
    await enqueue(boss, elena, revisionId);
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
    await enqueue(boss, elena, revisionId);
    const derived = await settled(revisionId);
    expect(derived.status).toMatchObject({
      state: 'failed',
      error: 'The file is not part of this reading',
    });
    // An uploaded file missing from the store is final as well: retrying cannot bring it back.
    const gone = 'courses/00000000-0000-4000-8000-000000000101/objects/0000';
    const missing = await revision('reading_pdf', { objectKey: gone }, [gone]);
    await enqueue(boss, elena, missing);
    expect((await settled(missing)).status).toMatchObject({
      state: 'failed',
      error: 'The uploaded file is no longer available; upload it again',
    });
  });

  test('two saves of one new revision at once queue one job', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Twice' });
    const results = await Promise.all([
      enqueueIfUnprocessed(boss, testDb.db, elena, revisionId),
      enqueueIfUnprocessed(boss, testDb.db, elena, revisionId),
      enqueueIfUnprocessed(boss, testDb.db, elena, revisionId),
    ]);
    expect(results.filter((r) => r !== null)).toEqual([expect.any(String)]);
    // A revision that already has a status is left as it is.
    expect(await enqueueIfUnprocessed(boss, testDb.db, elena, revisionId)).toBeNull();
    await settled(revisionId);
  });

  test('a status that changed since it was read is not queued over', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Stale' });
    const read = await readStatus(testDb.db, elena, revisionId);
    expect(read).toEqual({ raw: null, tag: null });
    expect(await enqueue(boss, elena, revisionId)).toEqual(expect.any(String));
    // A second caller acting on the earlier read (no status) queues nothing.
    expect(
      await enqueueReadingIngest(boss, testDb.db, elena, revisionId, { tag: null }),
    ).toBeNull();
    await settled(revisionId);
  });

  test('a queue that cannot be created leaves the revision failed, not queued', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Queue' });
    const broken = {
      createQueue: async () => {
        throw new Error('advisory lock timeout');
      },
    } as unknown as PgBoss;
    await expect(enqueue(broken, elena, revisionId)).rejects.toThrow('advisory lock timeout');
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
    await enqueue(boss, elena, revisionId);
    expect(await settled(revisionId)).toMatchObject({ status: { state: 'ready' }, pageCount: 1 });
  });

  test('another course cannot enqueue or ingest this course’s revisions', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Private' });
    const olivia = await courseScope(ids.olivia, ids.linearModels);
    expect(await enqueue(boss, olivia, revisionId)).toBeNull();
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

  test('every enqueue brings the queue’s options back in line, not only the first', async () => {
    await boss.updateQueue(readingIngest.name, { retryLimit: 7 });
    const revisionId = await revision('reading_native', { markdown: '# Options' });
    await enqueue(boss, elena, revisionId);
    expect(await boss.getQueue(readingIngest.name)).toMatchObject({ retryLimit: 2 });
    await settled(revisionId);
  });

  test('invalid PDF reading content fails at once, as invalid native content does', async () => {
    const pdf = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      makePdf(['Ignored']),
      'application/pdf',
    );
    const revisionId = await revision('reading_pdf', { objectKey: 42 }, [pdf.key]);
    await enqueue(boss, elena, revisionId);
    const derived = await settled(revisionId);
    expect(derived.status).toMatchObject({
      state: 'failed',
      error: 'The reading content is not valid',
    });
    expect(derived.pages).toBeUndefined();
  });

  test('Markdown and HTML sources are capped well below PDFs, inline or uploaded', async () => {
    const big = `${'word '.repeat(1_100_000)}`;
    const inline = await revision('reading_native', { markdown: big });
    await enqueue(boss, elena, inline);
    expect((await settled(inline)).status).toMatchObject({
      state: 'failed',
      error: 'The reading is larger than 5 MB',
    });
    const file = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      Buffer.from(big),
      'text/markdown',
    );
    const uploaded = await revision('reading_native', { sourceKey: file.key, format: 'markdown' }, [
      file.key,
    ]);
    await enqueue(boss, elena, uploaded);
    expect((await settled(uploaded)).status).toMatchObject({
      state: 'failed',
      error: 'The file is larger than 5 MB',
    });
  });

  test('a stopped job writes no status after the stop; pg-boss settles it', async () => {
    const pdf = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      makePdf(['Stop']),
      'application/pdf',
    );
    const revisionId = await revision('reading_pdf', { objectKey: pdf.key }, [pdf.key]);
    const controller = new AbortController();
    const stopping: Storage = {
      ...storage,
      put: storage.put.bind(storage),
      head: storage.head.bind(storage),
      delete: storage.delete.bind(storage),
      get: async () => {
        controller.abort();
        throw new Error('connection closed by shutdown');
      },
    };
    await expect(
      runScopedJob(testDb.db, readingIngest, fakeJob(revisionId, 2, 2, controller.signal), {
        storage: stopping,
      }),
    ).rejects.toThrow('connection closed by shutdown');
    // Still the attempt's own `running`, not `failed`: the stop is not the reading's outcome.
    expect((await derivedOf(revisionId)).status).toMatchObject({ state: 'running' });
  });

  test('a revision this job does not process is neither queued nor written by it', async () => {
    const revisionId = await revision('slides_web', {});
    const converted = { ...statusFor(OTHER_JOB), state: 'ready' as const, job: 'slides.render' };
    await setDerivedStatus(testDb.db, elena, revisionId, converted);
    expect(await enqueue(boss, elena, revisionId)).toBeNull();
    expect(
      await runScopedJob(testDb.db, readingIngest, fakeJob(revisionId, 0), { storage }),
    ).toEqual({ status: 'completed', output: { failed: 'revision has nothing to process' } });
    expect((await derivedOf(revisionId)).status).toEqual(converted);
  });

  test('a job superseded by a newer one (Retry while it ran) writes neither status nor outputs', async () => {
    const pdf = await storeCourseObject(
      testDb.db,
      storage,
      elena,
      makePdf(['Twice']),
      'application/pdf',
    );
    // A newer job already owns the status: the older one does not start.
    const waiting = await revision('reading_pdf', { objectKey: pdf.key }, [pdf.key]);
    await setDerivedStatus(testDb.db, elena, waiting, statusFor(OTHER_JOB));
    expect(await runScopedJob(testDb.db, readingIngest, fakeJob(waiting, 0), { storage })).toEqual({
      status: 'completed',
      output: { superseded: true },
    });
    expect((await derivedOf(waiting)).status).toMatchObject({ state: 'queued', jobId: OTHER_JOB });

    // A newer job is queued while this one runs: this one's result is dropped.
    const running = await revision('reading_pdf', { objectKey: pdf.key }, [pdf.key]);
    const retried: Storage = {
      ...storage,
      put: storage.put.bind(storage),
      head: storage.head.bind(storage),
      delete: storage.delete.bind(storage),
      get: async (key) => {
        await setDerivedStatus(testDb.db, elena, running, statusFor(OTHER_JOB));
        return storage.get(key);
      },
    };
    expect(
      await runScopedJob(testDb.db, readingIngest, fakeJob(running, 0), { storage: retried }),
    ).toEqual({ status: 'completed', output: { superseded: true } });
    const derived = await derivedOf(running);
    expect(derived.status).toMatchObject({ state: 'queued', jobId: OTHER_JOB });
    expect(derived.pages).toBeUndefined();
  });

  test('a Retry that cannot be queued leaves a running job’s status, so its result still lands', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Held' });
    const running = { ...statusFor(OTHER_JOB), state: 'running' as const };
    await setDerivedStatus(testDb.db, elena, revisionId, running);
    const broken = {
      createQueue: async () => {
        throw new Error('advisory lock timeout');
      },
    } as unknown as PgBoss;
    await expect(enqueue(broken, elena, revisionId)).rejects.toThrow('advisory lock timeout');
    expect((await derivedOf(revisionId)).status).toEqual(running);
  });

  test('a pending status lists as failed once its job ended without writing, not before', async () => {
    const { db } = testDb;
    /** A revision that is its resource's head, so the job status list shows it. */
    const headRevision = async (title: string) => {
      const revisionId = await revision('reading_native', { markdown: `# ${title}` });
      const [row] = await db
        .select({ resourceId: resourceRevisions.resourceId })
        .from(resourceRevisions)
        .where(eq(resourceRevisions.id, revisionId));
      if (!row) throw new Error('no revision');
      await db
        .update(resources)
        .set({ headRevisionId: revisionId })
        .where(eq(resources.id, row.resourceId));
      return revisionId;
    };
    const listed = async (revisionId: string) =>
      (await listResourceJobStatus(db, elena)).find((r) => r.revisionId === revisionId)?.status;

    // Sent for a student, who is no editor: the worker refuses it and pg-boss dead-letters it.
    const refused = await headRevision('Refused');
    const refusedJob = await boss.send(readingIngest.name, {
      actorId: ids.sam,
      scope: { kind: 'course', courseId: ids.statistics },
      input: { revisionId: refused },
    } satisfies ScopedPayload);
    if (!refusedJob) throw new Error('not sent');
    await setDerivedStatus(db, elena, refused, statusFor(refusedJob));
    for (let i = 0; i < 60 && (await listed(refused))?.state === 'queued'; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await listed(refused)).toMatchObject({
      state: 'failed',
      jobId: refusedJob,
      error: 'Processing stopped without a result',
    });

    // A job still waiting in its queue, however long, lists as queued.
    await boss.createQueue('reading.ingest.idle');
    const waitingJob = await boss.send('reading.ingest.idle', {});
    if (!waitingJob) throw new Error('not sent');
    const waiting = await headRevision('Waiting');
    const old = { ...statusFor(waitingJob), updatedAt: '2026-01-01T00:00:00.000Z' };
    await setDerivedStatus(db, elena, waiting, old);
    expect(await listed(waiting)).toEqual(old);
  });

  test('an enqueued job is named in the status, so only it may write there', async () => {
    const revisionId = await revision('reading_native', { markdown: '# Named' });
    const jobId = await enqueue(boss, elena, revisionId);
    const derived = await settled(revisionId);
    expect(derived.status).toMatchObject({ state: 'ready', jobId });
  });
});
