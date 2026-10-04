import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { resourceRevisions, resources } from '../../src/db/schema';
import annotationsMap, {
  ANNOTATIONS_MAP,
  MappingPending,
} from '../../src/jobs/annotations-map.job';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { runScopedJob, type ScopedPayload } from '../../src/jobs/scoped';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
/** Jobs the adoption route sent; the test runs them as a worker would. */
const sent: { name: string; data: unknown }[] = [];
/** Set to make sends fail, as a lost queue connection would. */
let sendFails = false;
/** What request handlers logged at error level. */
const loggedErrors: unknown[][] = [];
const boss = {
  createQueue: async () => {},
  send: async (name: string, data: unknown) => {
    if (sendFails) throw new Error('queue unavailable');
    sent.push({ name, data });
    return `00000000-0000-4000-8000-00000000f0${String(sent.length).padStart(2, '0')}`;
  },
} as unknown as PgBoss;

// Revision 1 of “Why samples vary”, as reading ingestion (P1-08) records its blocks.
const story = 'Every sample tells a slightly different story.';
const collects = 'The sampling distribution collects those stories.';
// Revision 2: a new opening, the first paragraph reworded, the second one removed.
const opening = 'Start with one sample.';
const storyV2 = 'Note that every sample tells a slightly different story.';
const later = 'Bootstrap intervals come later.';

const block = (id: string, text: string) => ({ id, tag: 'p', text });
const ready = { state: 'ready', job: 'reading.ingest', jobId: null, updatedAt: now.toISOString() };

function passage(blockId: string, text: string, quote: string) {
  const start = text.indexOf(quote);
  const end = start + quote.length;
  return {
    kind: 'text',
    blockId,
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32),
  } as const;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  // Only `derived` may change on a revision (ADR-0003): ingestion writes the block map there.
  await testDb.db
    .update(resourceRevisions)
    .set({
      derived: {
        status: ready,
        blockMap: [block('aaaaaaaaaaaa', story), block('bbbbbbbbbbbb', collects)],
        figures: [],
      },
    })
    .where(eq(resourceRevisions.id, ids.samplingReadingV1));
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => now,
    boss,
  });
  app.addHook('onRequest', async (req) => {
    const error = req.log.error.bind(req.log);
    req.log.error = ((...args: Parameters<typeof error>) => {
      loggedErrors.push(args);
      error(...args);
    }) as typeof error;
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

const classA = `/api/classes/${ids.classA}`;
const reading = `${classA}/resources/${ids.samplingReading}`;

async function annotate(body: object) {
  const res = await call('sam', 'POST', `${reading}/annotations`, body);
  expect(res.status).toBe(200);
  return res.body as { id: string };
}

type Placement = {
  status: string;
  anchor: { kind: string; quote?: string; start?: number; end?: number } | null;
};
type Listed = { id: string; anchor: { quote?: string }; placement: Placement | null };
async function listed(who: PersonName, classPath = classA) {
  const res = await call(who, 'GET', `${classPath}/resources/${ids.samplingReading}/annotations`);
  expect(res.status).toBe(200);
  const byId = (items: Listed[]) => new Map(items.map((i) => [i.id, i]));
  return { annotations: byId(res.body.annotations), threads: byId(res.body.threads) };
}

/** A new revision of the reading, published as the next release by the course owner. */
async function publishRevision2(contentHash = 'reading-v2') {
  const { db } = testDb;
  const [rev] = await db
    .insert(resourceRevisions)
    .values({
      resourceId: ids.samplingReading,
      courseId: ids.statistics,
      type: 'reading_native',
      content: { markdown: [opening, storyV2, later].join('\n\n') },
      derived: {
        status: ready,
        blockMap: [
          block('cccccccccccc', opening),
          block('dddddddddddd', storyV2),
          block('eeeeeeeeeeee', later),
        ],
        figures: [],
      },
      contentHash,
      createdBy: ids.elena,
    })
    .returning();
  if (!rev) throw new Error('no revision');
  await db
    .update(resources)
    .set({ headRevisionId: rev.id, revision: sql`${resources.revision} + 1` })
    .where(eq(resources.id, ids.samplingReading));
  const published = await call('elena', 'POST', `/api/courses/${ids.statistics}/releases`);
  expect(published.status).toBe(200);
  return { revisionId: rev.id, releaseId: published.body.release.id as string };
}

const workerJob = (data: unknown, name = ANNOTATIONS_MAP): Job<unknown> => ({
  id: '00000000-0000-4000-8000-00000000fa11',
  name,
  data,
  expireInSeconds: 60,
  heartbeatSeconds: null,
  retryCount: 0,
  signal: new AbortController().signal,
});

describe('A06 marks across a changed source revision', () => {
  test('A06 a changed revision maps a mark correctly or shows Needs reattachment with the original context', async () => {
    const storyMark = passage('aaaaaaaaaaaa', story, 'tells a slightly different story');
    const removedMark = passage('bbbbbbbbbbbb', collects, 'sampling distribution');
    const note = await annotate({ kind: 'note', anchor: storyMark, body: 'Why different?' });
    const highlight = await annotate({ kind: 'highlight', anchor: removedMark });
    const general = await annotate({ kind: 'note', anchor: { kind: 'none' }, body: 'Reread' });
    const asked = await call('sam', 'POST', `${reading}/threads`, {
      audience: 'instructor',
      anchor: removedMark,
      body: 'Is this the same as the standard error?',
    });
    expect(asked.status).toBe(200);
    const question = asked.body as { id: string };

    // On the revision they were made on, marks sit at their original anchor.
    const before = await listed('sam');
    expect(before.annotations.get(note.id)?.placement).toMatchObject({
      status: 'original',
      anchor: storyMark,
    });

    const v2 = await publishRevision2();
    const preview = await call('priya', 'GET', `${classA}/adoption?releaseId=${v2.releaseId}`);
    expect(preview.status).toBe(200);
    // Adoption reports the affected marks Priya may see: the question, not Sam's private notes.
    expect(preview.body.totals.annotations).toBe(1);
    expect(preview.body.changed[0]).toMatchObject({
      resourceId: ids.samplingReading,
      affected: { annotations: 1 },
    });

    const adopted = await call('priya', 'POST', `${classA}/adopt`, {
      releaseId: v2.releaseId,
      expectedReleaseId: ids.releaseV1,
    });
    expect(adopted.status).toBe(200);
    expect(adopted.body.diff.totals.annotations).toBe(1);
    expect(sent.map((s) => s.name)).toEqual([ANNOTATIONS_MAP]);

    // Until the job runs, the marks are pending on the new revision, never guessed.
    const waiting = await listed('sam');
    expect(waiting.annotations.get(note.id)?.placement).toMatchObject({
      status: 'pending',
      anchor: null,
    });

    const outcome = await runScopedJob(testDb.db, annotationsMap, workerJob(sent[0]?.data));
    expect(outcome).toEqual({
      status: 'completed',
      output: { mapped: 2, needsReattachment: 2, pending: 0 },
    });

    const after = await listed('sam');
    const mapped = after.annotations.get(note.id);
    expect(mapped?.placement).toMatchObject({
      status: 'mapped',
      anchor: { kind: 'text', blockId: 'dddddddddddd', quote: 'tells a slightly different story' },
    });
    const anchor = mapped?.placement?.anchor;
    expect(storyV2.slice(anchor?.start, anchor?.end)).toBe('tells a slightly different story');
    expect(after.annotations.get(general.id)?.placement).toMatchObject({ status: 'mapped' });
    // The removed passage: Needs reattachment, with the original quote and context kept.
    const lost = after.annotations.get(highlight.id);
    expect(lost?.placement).toMatchObject({ status: 'needs_reattachment', anchor: null });
    expect(lost?.anchor).toEqual(removedMark);
    expect(after.threads.get(question.id)?.placement?.status).toBe('needs_reattachment');

    // Class B still uses revision 1: the same reading there is unaffected.
    const elsewhere = await call(
      'bea',
      'POST',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/annotations`,
      {
        kind: 'highlight',
        anchor: removedMark,
      },
    );
    expect(elsewhere.body.placement).toMatchObject({ status: 'original', anchor: removedMark });

    // A second run (a retry, or a duplicate job) changes nothing.
    const again = await runScopedJob(testDb.db, annotationsMap, workerJob(sent[0]?.data));
    expect(again).toEqual({
      status: 'completed',
      output: { mapped: 0, needsReattachment: 0, pending: 0 },
    });
  });

  test('A06 the instructor maps a question by hand; private notes stay private', async () => {
    const list = await call('priya', 'GET', `${classA}/placements`);
    expect(list.status).toBe(200);
    // Only discussions the instructor may read; nothing about Sam's private notes.
    expect(Object.keys(list.body).sort()).toEqual(['releaseId', 'threads']);
    expect(list.body.threads).toHaveLength(1);
    const [item] = list.body.threads;
    expect(item).toMatchObject({
      resourceTitle: 'Why samples vary',
      originalRevisionId: ids.samplingReadingV1,
      anchor: { quote: 'sampling distribution', suffix: ' collects those stories.' },
      placement: { status: 'needs_reattachment', anchor: null },
    });
    // Students cannot open the instructor list.
    expect((await call('sam', 'GET', `${classA}/placements`)).status).toBe(403);

    const target = passage('eeeeeeeeeeee', later, 'Bootstrap intervals');
    const placed = await call('priya', 'PUT', `${classA}/placements`, {
      threadId: item.threadId,
      anchor: target,
    });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({ status: 'manual', anchor: target, confidence: null });
    expect((await listed('sam')).threads.get(item.threadId)?.placement).toMatchObject({
      status: 'manual',
      anchor: target,
    });
    // An anchor of another kind cannot stand in for the passage.
    const wrongKind = await call('priya', 'PUT', `${classA}/placements`, {
      threadId: item.threadId,
      anchor: { kind: 'none' },
    });
    expect(wrongKind.status).toBe(400);

    // The private highlight: its author reattaches it; the instructor cannot even find it.
    const own = [...(await listed('sam')).annotations.values()].find(
      (a) => a.placement?.status === 'needs_reattachment',
    );
    if (!own) throw new Error('no mark needs reattachment');
    expect(
      (await call('priya', 'PUT', `${classA}/placements`, { annotationId: own.id, anchor: target }))
        .status,
    ).toBe(404);
    const instructorView = (await call('priya', 'GET', `${classA}/placements`)).body;
    const mine = await call('sam', 'PUT', `${classA}/placements`, {
      annotationId: own.id,
      anchor: target,
    });
    expect(mine.body).toMatchObject({ status: 'manual', anchor: target });
    // Reattaching a private note leaves the instructor's list exactly as it was.
    expect((await call('priya', 'GET', `${classA}/placements`)).body).toEqual(instructorView);

    // The job never overwrites a manual placement.
    const rerun = await runScopedJob(testDb.db, annotationsMap, workerJob(sent[0]?.data));
    expect(rerun).toMatchObject({ output: { mapped: 0, needsReattachment: 0 } });
    expect((await listed('sam')).annotations.get(own.id)?.placement?.status).toBe('manual');
  });

  test('A06 adopting again counts marks placed on the revision the class leaves', async () => {
    const back = await call('priya', 'GET', `${classA}/adoption?releaseId=${ids.releaseV1}`);
    expect(back.status).toBe(200);
    // Sam's question, placed on revision 2; neither his private notes nor class B's marks count.
    expect(back.body.totals.annotations).toBe(1);
  });

  test('A06 a job for a release the class has since left does nothing', async () => {
    const stale = { ...(sent[0]?.data as object), input: { releaseId: ids.releaseV1 } };
    const outcome = await runScopedJob(testDb.db, annotationsMap, workerJob(stale));
    expect(outcome).toEqual({ status: 'completed', output: { skipped: 'release changed' } });
  });
});

describe('A06 marks while a revision is still being converted', () => {
  let v3: { revisionId: string; releaseId: string };
  const converting = {
    state: 'running',
    job: 'reading.ingest',
    jobId: '00000000-0000-4000-8000-00000000c0de',
    updatedAt: now.toISOString(),
  };
  const statuses = async (who: PersonName, classPath: string) =>
    [...(await listed(who, classPath)).annotations.values()].map((a) => a.placement?.status);

  test('A06 marks wait as pending while the pinned revision converts, and the job retries', async () => {
    v3 = await publishRevision2('reading-v3');
    // Its outputs are being produced again (an editor's Retry): none are there yet.
    await testDb.db
      .update(resourceRevisions)
      .set({ derived: { status: converting } })
      .where(eq(resourceRevisions.id, v3.revisionId));

    const current = await call('priya', 'GET', `${classA}/releases`);
    const adopted = await call('priya', 'POST', `${classA}/adopt`, {
      releaseId: v3.releaseId,
      expectedReleaseId: current.body.currentReleaseId,
    });
    expect(adopted.status).toBe(200);
    const job = sent.at(-1);
    expect(job?.name).toBe(ANNOTATIONS_MAP);

    // Nothing is guessed: the job leaves every mark pending and fails, so pg-boss retries it.
    await expect(runScopedJob(testDb.db, annotationsMap, workerJob(job?.data))).rejects.toThrow(
      MappingPending,
    );
    expect(await statuses('sam', classA)).toEqual(['pending', 'pending', 'pending']);
  });

  test('A06 an adoption whose mapping cannot be queued still succeeds; marks stay pending', async () => {
    const classB = `/api/classes/${ids.classB}`;
    const queued = sent.length;
    loggedErrors.length = 0;
    sendFails = true;
    try {
      const adopted = await call('marcus', 'POST', `${classB}/adopt`, {
        releaseId: v3.releaseId,
        expectedReleaseId: ids.releaseV1,
      });
      expect(adopted.status).toBe(200);
    } finally {
      sendFails = false;
    }
    expect(sent.length).toBe(queued);
    expect(loggedErrors.map(([, message]) => message)).toEqual([
      'could not queue annotation mapping',
    ]);
    expect((await call('marcus', 'GET', `${classB}/releases`)).body.currentReleaseId).toBe(
      v3.releaseId,
    );
    // Bea's highlight, made on revision 1, waits on revision 3.
    expect(await statuses('bea', classB)).toEqual(['pending']);
  });

  test('A06 once conversion finishes, mapping is queued again for each class and places the pending marks', async () => {
    const classB = `/api/classes/${ids.classB}`;
    // Ingestion runs as the course editor; when the outputs are written it queues mapping for
    // every class whose release pins this reading, as the instructor who adopted it.
    const queued = sent.length;
    const ingest: ScopedPayload = {
      actorId: ids.elena,
      scope: { kind: 'course', courseId: ids.statistics },
      input: { revisionId: v3.revisionId },
    };
    const ingested = await runScopedJob(
      testDb.db,
      readingIngest,
      { ...workerJob(ingest, readingIngest.name), id: converting.jobId },
      { boss },
    );
    expect(ingested).toEqual({
      status: 'completed',
      output: { revisionId: v3.revisionId, state: 'ready', mappingQueued: 2 },
    });
    const requeued = sent.slice(queued);
    expect(requeued.map((s) => s.name)).toEqual([ANNOTATIONS_MAP, ANNOTATIONS_MAP]);
    const payloads = requeued.map((s) => s.data as ScopedPayload);
    expect(
      payloads.map((p) => [p.actorId, p.scope, p.input]).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual(
      [
        [ids.priya, { kind: 'class', classId: ids.classA }, { releaseId: v3.releaseId }],
        [ids.marcus, { kind: 'class', classId: ids.classB }, { releaseId: v3.releaseId }],
      ].sort((a, b) => (a < b ? -1 : 1)),
    );

    for (const payload of payloads) {
      const outcome = await runScopedJob(testDb.db, annotationsMap, workerJob(payload));
      expect(outcome).toMatchObject({ status: 'completed', output: { pending: 0 } });
    }
    // The rendered revision 3 keeps revision 2's passages: Sam's notes map again, the manual
    // placement on revision 2 is the starting point for the reattached highlight.
    expect(await statuses('sam', classA)).toEqual(['mapped', 'mapped', 'mapped']);
    const story = [...(await listed('sam', classA)).annotations.values()].find(
      (a) => a.anchor.quote === 'tells a slightly different story',
    );
    expect(story?.placement?.anchor).toMatchObject({ quote: 'tells a slightly different story' });
    // Bea's highlight on a passage revision 3 no longer has: Needs reattachment, not pending.
    expect(await statuses('bea', classB)).toEqual(['needs_reattachment']);
  });
});
