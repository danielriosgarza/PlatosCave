import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { resourceRevisions, resources } from '../../src/db/schema';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { runScopedJob, type ScopedPayload } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
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
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
});

const MARKDOWN = `# Sampling

Why samples vary

---

## Two ideas

- the sample mean moves
- the spread shrinks

<script>alert(1)</script>

---

Same line

---

Same line
`;

interface Body {
  decks: { title: string; revisionId: string; position: unknown }[];
  status: string;
  error: string | null;
  sourceKey: string | null;
  pdf: unknown;
  web: { slides: string[] } | null;
}

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let root: string;
let storage: FsStorage;
let deck = '';
let empty = '';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

const fakeJob = (revisionId: string): Job<unknown> => ({
  id: '00000000-0000-4000-8000-00000000beef',
  name: readingIngest.name,
  data: {
    actorId: ids.elena,
    scope: { kind: 'course', courseId: ids.statistics },
    input: { revisionId },
  } satisfies ScopedPayload,
  expireInSeconds: 60,
  heartbeatSeconds: null,
  retryCount: 0,
  signal: new AbortController().signal,
});

const call = async (who: PersonName, method: 'GET' | 'PUT', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() as Body };
};
const list = (who: PersonName) =>
  call(who, 'GET', `/api/classes/${ids.classA}/topics/${ids.sampling}/slides`);
const read = (who: PersonName, revisionId: string) =>
  call(who, 'GET', `/api/classes/${ids.classA}/resources/${revisionId}/slides`);
const save = (who: PersonName, revisionId: string, position: object) =>
  call(who, 'PUT', `/api/classes/${ids.classA}/positions`, {
    revisionId,
    tab: 'slides',
    position,
  });

async function addWebDeck(title: string, position: number, markdown: string) {
  const { db } = testDb;
  const resource = one(
    await db
      .insert(resources)
      .values({
        courseId: ids.statistics,
        topicId: ids.sampling,
        type: 'slides_web',
        title,
        position,
        createdBy: ids.elena,
      })
      .returning(),
  );
  const revision = one(
    await db
      .insert(resourceRevisions)
      .values({
        resourceId: resource.id,
        courseId: ids.statistics,
        type: 'slides_web',
        content: { markdown },
        contentHash: title,
        createdBy: ids.elena,
      })
      .returning(),
  );
  await db
    .update(resources)
    .set({ headRevisionId: revision.id })
    .where(eq(resources.id, resource.id));
  return { resourceId: resource.id, revisionId: revision.id };
}

const derivedOf = async (revisionId: string) => {
  const row = one(
    await testDb.db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, revisionId)),
  );
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the stored JSON freely.
  return row.derived as Record<string, any>;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-web-slides-'));
  storage = new FsStorage(root);
  app = await buildApp(config, { db: testDb.db, storage, now: () => now });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('web slides', () => {
  test('the ingestion job renders a Markdown deck into sanitised per-slide HTML with block ids', async () => {
    const added = await addWebDeck('Sampling in slides', 20, MARKDOWN);
    deck = added.revisionId;
    expect(await runScopedJob(testDb.db, readingIngest, fakeJob(deck), { storage })).toMatchObject({
      status: 'completed',
      output: { state: 'ready' },
    });
    const derived = await derivedOf(deck);
    expect(derived.status.state).toBe('ready');
    expect(derived.pageCount).toBe(4);
    expect(derived.slides).toHaveLength(4);
    expect(derived.slides[0]).toContain('<h1 data-block-id="');
    expect(derived.slides.join('')).not.toContain('<script');
    // Block ids are unique over the deck, including the repeated line on slides 3 and 4.
    const blocks = derived.blockMap as { id: string; slide: number }[];
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(blocks.map((b) => b.slide)).toContain(4);
  });

  test('a deck with no slides fails at once with the reason', async () => {
    const added = await addWebDeck('Nothing yet', 21, '\n---\n\n---\n');
    empty = added.revisionId;
    await runScopedJob(testDb.db, readingIngest, fakeJob(empty), { storage });
    expect((await derivedOf(empty)).status).toMatchObject({
      state: 'failed',
      error: 'The deck has no slides',
    });
  });

  test('publication is blocked while a web deck has failed, and passes once it is archived', async () => {
    const { db } = testDb;
    const elena = asCourseScope(ids.statistics, ids.elena);
    const blocked = await publishRelease(db, elena);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.report.errors).toEqual([
      expect.objectContaining({
        code: 'unprocessed_reading',
        message: expect.stringContaining('Nothing yet'),
      }),
    ]);
    const emptyResource = one(
      await db
        .select({ id: resourceRevisions.resourceId })
        .from(resourceRevisions)
        .where(eq(resourceRevisions.id, empty)),
    );
    await db.update(resources).set({ archivedAt: now }).where(eq(resources.id, emptyResource.id));
    const published = await publishRelease(db, elena);
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    const adopted = await adoptRelease(db, asClassScope(ids.classA, ids.statistics, ids.priya), {
      releaseId: published.release.id,
      expectedReleaseId: ids.releaseV1,
    });
    if (!adopted.ok) throw new Error(adopted.reason);
  });

  test('the Slides tab lists the web deck and serves its slides to a student', async () => {
    const { body } = await list('sam');
    expect(body.decks.map((d) => [d.title, d.revisionId, d.position])).toEqual([
      ['Sampling in slides', deck, null],
    ]);
    const { status, body: content } = await read('sam', deck);
    expect(status).toBe(200);
    expect(content).toMatchObject({ status: 'ready', pdf: null, sourceKey: null });
    expect(content.web?.slides).toHaveLength(4);
    expect(content.web?.slides[1]).toContain('the sample mean moves');
    expect(content.web?.slides.join('')).not.toContain('<script');
  });

  test('a student and a non-member are kept apart as for any deck', async () => {
    expect((await read('bea', deck)).status).toBe(404);
    expect((await list('bea')).status).toBe(404);
    expect((await read('sam', empty)).status).toBe(404);
  });

  test('the last slide of a web deck is remembered, and one past the end is refused', async () => {
    expect((await save('sam', deck, { page: 3, offset: 0 })).status).toBe(200);
    expect((await list('sam')).body.decks[0]?.position).toEqual({ page: 3, offset: 0 });
    expect((await save('sam', deck, { page: 5, offset: 0 })).status).toBe(400);
    expect((await save('sam', deck, { blockId: 'b1', offset: 0 })).status).toBe(400);
    expect((await save('sam', deck, { page: 4, offset: 0 })).status).toBe(200);
  });
});
