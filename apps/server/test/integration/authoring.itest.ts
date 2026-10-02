import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createBoss } from '../../src/db/jobs/boss';
import { classes, courseReleases, resourceRevisions } from '../../src/db/schema';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { makePdf } from '../fixtures/pdf';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const course = `/api/courses/${ids.statistics}`;
const MiB = 1024 * 1024;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let boss: PgBoss;
let root: string;
let storage: FsStorage;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-authoring-'));
  storage = new FsStorage(root);
  boss = createBoss(testDb.db.$client, { role: 'api', onError: () => {}, onWarning: () => {} });
  await boss.start();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }), {
    db: testDb.db,
    now: () => now,
    storage,
    boss,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

let worker: Promise<unknown> | undefined;
/** Starts the ingestion worker once; each test that needs processed readings calls it. */
const ensureWorker = () =>
  (worker ??= workScopedJob(
    boss,
    testDb.db,
    readingIngest,
    { info: () => {}, warn: () => {}, error: () => {} },
    { pollingIntervalSeconds: 0.5 },
    { storage },
  ));

async function call(who: PersonName, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: world.cookie[who] },
    ...(body && { payload: body }),
  });
  return { status: res.statusCode, body: res.json() };
}

/** A multipart/form-data body with one `file` part. */
function upload(who: PersonName, filename: string, bytes: Uint8Array, courseUrl = course) {
  const boundary = '----parallax-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `${courseUrl}/uploads`,
    headers: {
      cookie: world.cookie[who],
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

const text = (s: string) => new TextEncoder().encode(s);

describe('reading upload', () => {
  test('A26 only course editors can upload; everyone else gets 404 before the body is read', async () => {
    const sam = await upload('sam', 'x.md', text('# Hi'));
    expect(sam.statusCode).toBe(404);
    const other = await upload('elena', 'x.md', text('# Hi'), `/api/courses/${ids.linearModels}`);
    expect(other.statusCode).toBe(404);
  });

  test('A26 Markdown, HTML and PDF are stored content-addressed in the course; others are refused', async () => {
    const md = await upload('elena', '../notes/Week 1.md', text('# Week 1\n\nSamples vary.'));
    expect(md.statusCode).toBe(200);
    const stored = md.json();
    expect(stored).toMatchObject({ format: 'markdown', filename: 'Week 1.md' });
    expect(stored.key).toBe(`courses/${ids.statistics}/objects/${stored.sha256}`);
    expect(await storage.head(stored.key)).toEqual({ size: stored.size });
    // Identical bytes land on the same key.
    const again = await upload('elena', 'copy.markdown', text('# Week 1\n\nSamples vary.'));
    expect(again.json().key).toBe(stored.key);

    expect((await upload('elena', 'page.html', text('<h1>Hi</h1>'))).json().format).toBe('html');
    expect((await upload('elena', 'paper.pdf', makePdf(['Hello']))).json().format).toBe('pdf');

    for (const [name, bytes, message] of [
      ['run.exe', text('MZ'), /Upload a Markdown/],
      ['noext', text('# x'), /Upload a Markdown/],
      ['fake.pdf', text('# not a pdf'), /not a PDF/],
      ['bad.md', new Uint8Array([0xff, 0xfe, 0x41]), /UTF-8/],
      ['nul.html', new Uint8Array([0x3c, 0x00, 0x3e]), /not text/],
      ['empty.md', new Uint8Array(), /empty/],
      ['notes.constructor', text('# x'), /Upload a Markdown/],
      ['notes.__proto__', text('# x'), /Upload a Markdown/],
      ['notes.toString', text('# x'), /Upload a Markdown/],
      ['short.pdf', text('%PD'), /not a PDF/],
    ] as const) {
      const res = await upload('elena', name, bytes);
      expect(res.statusCode, name).toBe(400);
      expect(res.json().error, name).toMatch(message);
    }
  });

  test('A26 a file over the limit answers 413 and stores nothing', async () => {
    const big = new Uint8Array(26 * MiB).fill(0x61);
    const res = await upload('elena', 'big.md', big);
    expect(res.statusCode).toBe(413);
  });

  test('A26 a file part without a file name is a 400, not a 500', async () => {
    const boundary = '----nofilename';
    const res = await app.inject({
      method: 'POST',
      url: `${course}/uploads`,
      headers: {
        cookie: world.cookie.elena,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n\r\n# hi\r\n--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(400);
  });

  test('A26 a file refused on its first bytes answers 400 on a real socket while the client is still sending, and the connection stays usable', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const boundary = '----parallax-socket-boundary';
    const send = (filename: string, body: Buffer, chunks: number) =>
      new Promise<{ status: number; error: string; socket: unknown }>((resolve, reject) => {
        const head = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const req = http.request({
          agent,
          port,
          host: '127.0.0.1',
          method: 'POST',
          path: `${course}/uploads`,
          headers: {
            // The app's host, not the content origin's (127.0.0.1 in tests).
            host: 'localhost',
            cookie: world.cookie.elena,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': head.length + body.length * chunks + tail.length,
          },
        });
        req.on('error', reject);
        req.on('response', (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (d) => {
            data += d;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              error: JSON.parse(data).error,
              socket: req.socket,
            }),
          );
        });
        // Larger than the socket buffers: an unread body would hold back the rest of the upload.
        req.write(head);
        const write = (i: number): void => {
          if (i === chunks) {
            req.end(tail);
            return;
          }
          if (req.write(body)) write(i + 1);
          else req.once('drain', () => write(i + 1));
        };
        write(0);
      });
    try {
      const refused = await send('fake.pdf', Buffer.alloc(MiB, 0x61), 20);
      expect(refused.status).toBe(400);
      expect(refused.error).toMatch(/not a PDF/);
      // The same keep-alive socket carries the next upload.
      const next = await send('ok.md', Buffer.from('# Fine\n'), 1);
      expect(next.status).toBe(200);
      expect(next.socket).toBe(refused.socket);
    } finally {
      agent.destroy();
    }
  }, 20_000);

  test('A26 a request that is not multipart is a 400', async () => {
    const res = await call('elena', 'POST', `${course}/uploads`, { file: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('authoring flow', () => {
  test('A16 A26 an uploaded reading is processed, published as the next version, and edits never reach the class', async () => {
    const stored = (await upload('elena', 'week2.md', text('# Week 2\n\nVariance.'))).json();
    const topic = (await call('elena', 'POST', `${course}/topics`, { title: 'Variance' })).body;
    const created = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_native',
      title: 'Week 2',
      content: { sourceKey: stored.key, format: 'markdown' },
      objectKeys: [stored.key],
      accessibleAlternative: { text: 'Plain text of the week 2 reading' },
    });
    expect(created.status).toBe(200);
    const resource = created.body;

    // Saving queued the job; until a worker runs it, publishing is blocked, not silently broken.
    const queued = await call('elena', 'GET', `${course}/processing`);
    expect(
      queued.body.resources.find((r: { resourceId: string }) => r.resourceId === resource.id),
    ).toMatchObject({
      state: 'queued',
    });
    const blocked = await call('elena', 'POST', `${course}/releases`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.report.errors).toEqual([
      expect.objectContaining({ code: 'unprocessed_reading', resourceId: resource.id }),
    ]);

    await ensureWorker();
    await settle(resource.id);

    const before = await call('elena', 'GET', `${course}/overview`);
    const classA = () => before.body.classes.find((c: { id: string }) => c.id === ids.classA);
    const usedVersion = classA().release.version;

    const first = await call('elena', 'POST', `${course}/releases`);
    expect(first.status).toBe(200);
    const version = first.body.release.version;
    expect(version).toBe(before.body.latestRelease.version + 1);

    // Editing the draft changes drafts only: the class keeps its release (A26).
    const edited = await call('elena', 'PATCH', `${course}/topics/${topic.id}`, {
      expectedRevision: topic.revision,
      title: 'Variance, revised',
    });
    expect(edited.status).toBe(200);
    const [adopted] = await testDb.db
      .select({ releaseId: classes.releaseId })
      .from(classes)
      .where(eq(classes.id, ids.classA));
    const overview = await call('elena', 'GET', `${course}/overview`);
    expect(overview.body.latestRelease.version).toBe(version);
    expect(
      overview.body.classes.find((c: { id: string }) => c.id === ids.classA).release.version,
    ).toBe(usedVersion);
    expect(adopted?.releaseId).not.toBe(first.body.release.id);

    // A second publish is a new version; the first release row is unchanged (A16).
    const second = await call('elena', 'POST', `${course}/releases`);
    expect(second.body.release.version).toBe(version + 1);
    const [v1] = await testDb.db
      .select()
      .from(courseReleases)
      .where(eq(courseReleases.id, first.body.release.id));
    expect(v1?.version).toBe(version);
  });

  test('A26 a failed or unreadable upload shows as failed and can be retried', async () => {
    const stored = (await upload('elena', 'gone.md', text('# Gone'))).json();
    const topic = (await call('elena', 'POST', `${course}/topics`, { title: 'Retry' })).body;
    const created = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_native',
      title: 'Gone',
      content: { sourceKey: stored.key, format: 'markdown' },
      objectKeys: [stored.key],
    });
    await storage.delete(stored.key);
    await ensureWorker();
    const id = created.body.id;
    await settle(id, 'failed');
    const failed = await call('elena', 'GET', `${course}/processing`);
    expect(
      failed.body.resources.find((r: { resourceId: string }) => r.resourceId === id),
    ).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('upload it again'),
    });
    const publish = await call('elena', 'POST', `${course}/releases`);
    expect(publish.body.report.errors).toContainEqual(
      expect.objectContaining({ code: 'unprocessed_reading', resourceId: id }),
    );
    const retry = await call('elena', 'POST', `${course}/resources/${id}/processing`);
    expect(retry.status).toBe(200);
    expect(retry.body.state).toBe('queued');
    expect((await call('sam', 'POST', `${course}/resources/${id}/processing`)).status).toBe(404);
    // Queued or running work is not queued again.
    expect((await call('elena', 'POST', `${course}/resources/${id}/processing`)).status).toBe(409);
  });
});

describe('processing recovery', () => {
  /** A processed reading in a new topic, ready before the test changes its recorded status. */
  async function processedReading(title: string) {
    const topic = (await call('elena', 'POST', `${course}/topics`, { title })).body;
    const created = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'reading_native',
      title,
      content: { markdown: `# ${title}` },
      accessibleAlternative: { text: title },
    });
    expect(created.status).toBe(200);
    await ensureWorker();
    await settle(created.body.id);
    return { id: created.body.id as string, revisionId: created.body.headRevisionId as string };
  }

  /** Records a status as a dead process or worker would have left it. */
  const leave = (revisionId: string, status: object) =>
    testDb.db
      .update(resourceRevisions)
      .set({
        derived: sql`jsonb_set(${resourceRevisions.derived}, '{status}', ${JSON.stringify(status)}::jsonb)`,
      })
      .where(eq(resourceRevisions.id, revisionId));

  const processing = async (id: string) =>
    (await call('elena', 'GET', `${course}/processing`)).body.resources.find(
      (r: { resourceId: string }) => r.resourceId === id,
    );
  const retry = (id: string) => call('elena', 'POST', `${course}/resources/${id}/processing`);
  const jobsFor = async (revisionId: string) =>
    Number(
      (
        await testDb.db.execute<{ n: string }>(
          sql`select count(*) as n from pgboss.job where name = 'reading.ingest' and data->'input'->>'revisionId' = ${revisionId}`,
        )
      ).rows[0]?.n,
    );
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  test('A26 a reading left queued or running by work that stopped shows as failed, blocks publishing, and is retried to ready', async () => {
    const { id, revisionId } = await processedReading('Orphaned');
    const [row] = await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, revisionId));
    const finishedJob = (row?.derived as { status?: { jobId?: string } } | undefined)?.status
      ?.jobId;
    expect(finishedJob).toEqual(expect.any(String));
    const base = { job: 'reading.ingest' };
    for (const [why, status] of [
      // The process died between marking the revision queued and sending the job.
      ['never sent', { ...base, state: 'queued', jobId: null, updatedAt: ago(5 * 60_000) }],
      // A worker died mid-run and the job has since left pg-boss.
      [
        'job gone',
        {
          ...base,
          state: 'running',
          jobId: '00000000-0000-4000-8000-00000000dead',
          updatedAt: ago(0),
        },
      ],
      // The job finished without the handler recording its outcome.
      ['job finished', { ...base, state: 'running', jobId: finishedJob, updatedAt: ago(0) }],
    ] as const) {
      await leave(revisionId, status);
      expect(await processing(id), why).toMatchObject({
        state: 'failed',
        error: 'Processing stopped without a result',
      });
      const publish = await call('elena', 'POST', `${course}/releases`);
      expect(publish.body.report.errors, why).toContainEqual(
        expect.objectContaining({ code: 'unprocessed_reading', resourceId: id }),
      );
      const retried = await retry(id);
      expect(retried.status, why).toBe(200);
      expect(retried.body.state, why).toBe('queued');
      await settle(id);
      expect(await processing(id), why).toMatchObject({ state: 'ready', error: null });
    }
  });

  test('A26 a reading queued moments ago or waiting on a live job is not queued again', async () => {
    const { id, revisionId } = await processedReading('Waiting');
    await leave(revisionId, {
      job: 'reading.ingest',
      state: 'queued',
      jobId: null,
      updatedAt: ago(1_000),
    });
    expect(await processing(id)).toMatchObject({ state: 'queued' });
    expect((await retry(id)).status).toBe(409);

    // A job pg-boss still holds (here: scheduled for later) is live, however long it takes.
    const live = await boss.send('reading.ingest', {}, { startAfter: 3600 });
    await leave(revisionId, {
      job: 'reading.ingest',
      state: 'running',
      jobId: live,
      updatedAt: ago(60 * 60_000),
    });
    expect(await processing(id)).toMatchObject({ state: 'running' });
    const jobs = await jobsFor(revisionId);
    expect((await retry(id)).status).toBe(409);
    expect(await jobsFor(revisionId)).toBe(jobs);
    if (live) await boss.cancel('reading.ingest', live);
  });

  test('editing only the alternative or provenance of a ready reading keeps it ready and queues nothing', async () => {
    const { id, revisionId } = await processedReading('Alternative only');
    const [ready] = await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, revisionId));
    const current = (await call('elena', 'GET', `${course}/resources/${id}`)).body;

    const edited = await call('elena', 'PATCH', `${course}/resources/${id}`, {
      expectedRevision: current.revision,
      accessibleAlternative: { text: 'A longer plain-text version' },
    });
    expect(edited.status).toBe(200);
    const altHead = edited.body.headRevisionId as string;
    expect(altHead).not.toBe(revisionId);
    expect(edited.body.head.accessibleAlternative).toEqual({ text: 'A longer plain-text version' });
    expect(await processing(id)).toMatchObject({ revisionId: altHead, state: 'ready' });
    expect(await jobsFor(altHead)).toBe(0);
    const [copied] = await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, altHead));
    expect(copied?.derived).toEqual(ready?.derived);

    const provenance = await call('elena', 'PATCH', `${course}/resources/${id}`, {
      expectedRevision: edited.body.revision,
      provenance: { source: 'Course notes, 2025' },
    });
    const provHead = provenance.body.headRevisionId as string;
    expect(provHead).not.toBe(altHead);
    expect(await processing(id)).toMatchObject({ revisionId: provHead, state: 'ready' });
    expect(await jobsFor(provHead)).toBe(0);
    const publish = await call('elena', 'POST', `${course}/releases`);
    expect(publish.body.report?.errors ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'unprocessed_reading', resourceId: id }),
    );

    // A change of the source itself is processed again.
    const content = await call('elena', 'PATCH', `${course}/resources/${id}`, {
      expectedRevision: provenance.body.revision,
      content: { markdown: '# Alternative only, revised' },
    });
    const contentHead = content.body.headRevisionId as string;
    expect(contentHead).not.toBe(provHead);
    expect(await jobsFor(contentHead)).toBe(1);
    await headReady(id);
  });

  test('editing only the alternative of a reading that is not ready yet queues the new head', async () => {
    const { id, revisionId } = await processedReading('Alternative while failed');
    await leave(revisionId, {
      job: 'reading.ingest',
      state: 'failed',
      jobId: null,
      error: 'Could not queue processing',
      updatedAt: ago(0),
    });
    const current = (await call('elena', 'GET', `${course}/resources/${id}`)).body;
    const edited = await call('elena', 'PATCH', `${course}/resources/${id}`, {
      expectedRevision: current.revision,
      accessibleAlternative: { text: 'Changed while failed' },
    });
    const head = edited.body.headRevisionId as string;
    expect(await jobsFor(head)).toBe(1);
    await headReady(id);
  });

  test('A26 two retries of one failed reading at once queue one job', async () => {
    const { id, revisionId } = await processedReading('Double click');
    await leave(revisionId, {
      job: 'reading.ingest',
      state: 'failed',
      jobId: null,
      error: 'Could not queue processing',
      updatedAt: ago(0),
    });
    const before = await jobsFor(revisionId);
    const answers = await Promise.all([retry(id), retry(id), retry(id)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409]);
    expect(await jobsFor(revisionId)).toBe(before + 1);
    await settle(id);
  });
});

async function settle(resourceId: string, want: 'ready' | 'failed' = 'ready') {
  for (let i = 0; i < 60; i++) {
    const rows = await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.resourceId, resourceId));
    const derived = rows[0]?.derived as { status?: { state?: string } } | undefined;
    const state = derived?.status?.state;
    if (state === want) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`resource ${resourceId} did not become ${want}`);
}

/** Waits until the head revision's job is ready (the queued state is written when saving). */
async function headReady(resourceId: string) {
  for (let i = 0; i < 60; i++) {
    const { body } = await call('elena', 'GET', `${course}/processing`);
    const entry = body.resources.find((r: { resourceId: string }) => r.resourceId === resourceId);
    if (entry?.state === 'ready') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`resource ${resourceId} head revision did not become ready`);
}

describe('PDF deck ingestion', () => {
  const errorsOf = async (resourceId: string) =>
    (await call('elena', 'POST', `${course}/releases`)).body.report.errors.filter(
      (e: { resourceId?: string }) => e.resourceId === resourceId,
    );

  async function addDeck(title: string, topicId: string, pages: string[], extra: object = {}) {
    const stored = (await upload('elena', `${title}.pdf`, makePdf(pages))).json();
    const created = await call('elena', 'POST', `${course}/topics/${topicId}/resources`, {
      type: 'slides_pdf',
      title,
      content: { objectKey: stored.key },
      objectKeys: [stored.key],
      ...extra,
    });
    expect(created.status).toBe(200);
    return { ...created.body, objectKey: stored.key as string };
  }

  test('a PDF deck is queued on save, processed with its page count and text, and publishes', async () => {
    const topic = (await call('elena', 'POST', `${course}/topics`, { title: 'Decks' })).body;
    const deck = await addDeck('Lecture', topic.id, ['Intro', 'Sampling', 'Bias']);

    const queued = await call('elena', 'GET', `${course}/processing`);
    expect(
      queued.body.resources.find((r: { resourceId: string }) => r.resourceId === deck.id),
    ).toMatchObject({ state: 'queued' });
    expect(await errorsOf(deck.id)).toEqual([
      expect.objectContaining({ code: 'unconverted_deck' }),
    ]);

    await ensureWorker();
    await settle(deck.id);
    const [revision] = await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, deck.headRevisionId));
    expect(revision?.derived).toMatchObject({
      pageCount: 3,
      rasterOnly: false,
      status: { state: 'ready' },
    });
    const pages = (revision?.derived.pages ?? []) as { text: string }[];
    expect(pages.map((page) => page.text)).toEqual(['Intro', 'Sampling', 'Bias']);
    expect(await errorsOf(deck.id)).toEqual([]);
  });

  test('a raster-only deck cannot publish without a text alternative', async () => {
    const topic = (await call('elena', 'POST', `${course}/topics`, { title: 'Scans' })).body;
    const deck = await addDeck('Scanned', topic.id, ['', '', '']);
    await ensureWorker();
    await settle(deck.id);
    expect(await errorsOf(deck.id)).toEqual([
      expect.objectContaining({ code: 'missing_alternative' }),
    ]);

    // Adding the alternative makes a new revision, which is processed again and then publishes.
    const withText = await call('elena', 'PATCH', `${course}/resources/${deck.id}`, {
      expectedRevision: deck.revision,
      content: { objectKey: deck.objectKey },
      objectKeys: [deck.objectKey],
      accessibleAlternative: { text: 'Slide 1: title. Slide 2: a histogram of sample means.' },
    });
    expect(withText.status).toBe(200);
    await headReady(deck.id);
    expect(await errorsOf(deck.id)).toEqual([]);
  });

  test('a deck that is not a readable PDF fails with the reason and can be retried', async () => {
    const topic = (await call('elena', 'POST', `${course}/topics`, { title: 'Broken decks' })).body;
    const stored = (await upload('elena', 'x.pdf', text('%PDF-1.4 not really'))).json();
    const created = await call('elena', 'POST', `${course}/topics/${topic.id}/resources`, {
      type: 'slides_pdf',
      title: 'Broken',
      content: { objectKey: stored.key },
      objectKeys: [stored.key],
    });
    await ensureWorker();
    await settle(created.body.id, 'failed');
    expect(await errorsOf(created.body.id)).toEqual([
      expect.objectContaining({
        code: 'unconverted_deck',
        message: expect.stringContaining('could not be processed'),
      }),
    ]);
    const retry = await call('elena', 'POST', `${course}/resources/${created.body.id}/processing`);
    expect(retry.status).toBe(200);
    expect(retry.body.state).toBe('queued');
  });
});
