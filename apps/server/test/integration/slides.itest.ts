import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { writeDerivedOutputs } from '../../src/db/jobs/derived';
import { resourceRevisions, resources } from '../../src/db/schema';
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
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
});
const ready = {
  state: 'ready' as const,
  job: 'reading.ingest',
  jobId: null,
  updatedAt: now.toISOString(),
};
const bytes = Buffer.from('0123456789abcdefghij');

interface Body {
  decks: { title: string; position: unknown }[];
  lastRevisionId: string | null;
  status: string;
  sourceKey: string | null;
  pdf: { url: string; pageCount: number } | null;
  updatedAt: string;
}

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let root: string;
let clock = now;
let pdfKey = '';
const deck: Record<'first' | 'second' | 'pending' | 'hidden', string> = {
  first: '',
  second: '',
  pending: '',
  hidden: '',
};

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

const call = async (who: PersonName, method: 'GET' | 'PUT', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() as Body };
};
const list = (who: PersonName, classId: string) =>
  call(who, 'GET', `/api/classes/${classId}/topics/${ids.sampling}/slides`);
const read = (who: PersonName, classId: string, revisionId: string) =>
  call(who, 'GET', `/api/classes/${classId}/resources/${revisionId}/slides`);
const save = (who: PersonName, classId: string, body: object) =>
  call(who, 'PUT', `/api/classes/${classId}/positions`, body);

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-slides-'));
  const storage = new FsStorage(root);
  app = await buildApp(config, { db: testDb.db, storage, now: () => clock });
  await app.ready();

  const { db } = testDb;
  const elena = asCourseScope(ids.statistics, ids.elena);
  pdfKey = (await storeCourseObject(db, storage, elena, bytes, 'application/pdf')).key;

  const addDeck = async (
    title: string,
    position: number,
    visibility: 'visible' | 'hidden' = 'visible',
  ) => {
    const resource = one(
      await db
        .insert(resources)
        .values({
          courseId: ids.statistics,
          topicId: ids.sampling,
          type: 'slides_pdf',
          title,
          position,
          visibility,
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
          type: 'slides_pdf',
          content: { objectKey: pdfKey },
          accessibleAlternative: { text: title },
          objectKeys: [pdfKey],
          contentHash: title,
          createdBy: ids.elena,
        })
        .returning(),
    );
    await db
      .update(resources)
      .set({ headRevisionId: revision.id })
      .where(eq(resources.id, resource.id));
    return revision.id;
  };
  deck.first = await addDeck('Sampling lecture', 10);
  deck.second = await addDeck('Sampling recap', 11);
  deck.pending = await addDeck('Still converting', 12);
  deck.hidden = await addDeck('Instructor deck', 13, 'hidden');
  for (const id of Object.values(deck)) {
    await writeDerivedOutputs(
      db,
      elena,
      id,
      { pageCount: 12, pages: [], rasterOnly: false },
      ready,
    );
  }

  const published = await publishRelease(db, elena);
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(db, asClassScope(ids.classA, ids.statistics, ids.priya), {
    releaseId: published.release.id,
    expectedReleaseId: ids.releaseV1,
  });
  if (!adopted.ok) throw new Error(adopted.reason);
  // This deck's conversion runs again after release, as a re-run of the job can.
  await writeDerivedOutputs(
    db,
    elena,
    deck.pending,
    {},
    { ...ready, jobId: 'job-1', state: 'running' },
  );
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('slide decks', () => {
  test('lists the topic decks a student may open, in authored order, with no slide yet', async () => {
    const { status, body } = await list('sam', ids.classA);
    expect(status).toBe(200);
    expect(body.decks.map((d) => [d.title, d.position])).toEqual([
      ['Sampling lecture', null],
      ['Sampling recap', null],
      ['Still converting', null],
    ]);
    expect(body.lastRevisionId).toBeNull();
    // The instructor also sees the hidden deck.
    expect((await list('priya', ids.classA)).body.decks).toHaveLength(4);
  });

  test('a deck comes back as a short-lived content link with its page count and source key', async () => {
    const { status, body } = await read('sam', ids.classA, deck.first);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', sourceKey: pdfKey });
    expect(body.pdf?.pageCount).toBe(12);
    expect(body.pdf?.url).toMatch(/^http:\/\/localhost:3100\/content\//);
    expect((await read('sam', ids.classA, deck.pending)).body).toMatchObject({
      status: 'pending',
      pdf: null,
    });
  });

  test('a hidden deck, a reading, another class and a non-member get 404', async () => {
    expect((await read('sam', ids.classA, deck.hidden)).status).toBe(404);
    expect((await read('priya', ids.classA, deck.hidden)).status).toBe(200);
    expect((await read('sam', ids.classA, ids.samplingReadingV1)).status).toBe(404);
    expect((await read('bea', ids.classA, deck.first)).status).toBe(404);
    expect((await list('bea', ids.classA)).status).toBe(404);
  });

  test('the last slide is remembered per user and deck revision', async () => {
    // Each save a second later, so "studied last" is the latest, not a tie.
    const put = (revisionId: string, page: number) => {
      clock = new Date(clock.getTime() + 1000);
      return save('sam', ids.classA, { revisionId, tab: 'slides', position: { page, offset: 0 } });
    };
    expect((await put(deck.first, 5)).status).toBe(200);
    expect((await put(deck.second, 2)).status).toBe(200);
    expect((await put(deck.first, 7)).status).toBe(200);
    const sam = (await list('sam', ids.classA)).body;
    expect(sam.decks.map((d) => d.position)).toEqual([
      { page: 7, offset: 0 },
      { page: 2, offset: 0 },
      null,
    ]);
    expect(sam.lastRevisionId).toBe(deck.first);
    // Another person's place is their own.
    expect((await list('priya', ids.classA)).body.decks[0]?.position).toBeNull();
  });

  test('a slide past the end, a block position, or the wrong tab is refused', async () => {
    const put = (position: object, tab = 'slides') =>
      save('sam', ids.classA, { revisionId: deck.first, tab, position });
    expect((await put({ page: 13, offset: 0 })).status).toBe(400);
    expect((await put({ blockId: 'b1', offset: 0 })).status).toBe(400);
    expect((await put({ page: 1, offset: 0 }, 'reading')).status).toBe(400);
    expect((await put({ page: 12, offset: 0 })).status).toBe(200);
  });
});

describe('deck file ranges', () => {
  const fetchRange = async (range?: string) => {
    const { body } = await read('sam', ids.classA, deck.first);
    const path = new URL(body.pdf?.url ?? '').pathname;
    return app.inject({
      method: 'GET',
      url: path,
      headers: { host: 'localhost:3100', ...(range && { range }) },
    });
  };

  test('the content origin answers a byte range with 206 and its slice', async () => {
    const res = await fetchRange('bytes=5-9');
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('56789');
    expect(res.headers).toMatchObject({
      'content-range': 'bytes 5-9/20',
      'content-length': '5',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': 'http://127.0.0.1:3100',
    });
    expect((await fetchRange('bytes=15-')).body).toBe('fghij');
    expect((await fetchRange('bytes=-3')).body).toBe('hij');
  });

  test('an unsatisfiable range is 416, and a missing or odd header serves the whole file', async () => {
    const past = await fetchRange('bytes=20-30');
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */20');
    for (const range of [undefined, 'bytes=0-1,5-6', 'items=1-2']) {
      const whole = await fetchRange(range);
      expect(whole.statusCode, String(range)).toBe(200);
      expect(whole.body).toBe(bytes.toString());
    }
  });

  test('a preflight lets the app origin send a Range header and nothing more', async () => {
    const { body } = await read('sam', ids.classA, deck.first);
    const res = await app.inject({
      method: 'OPTIONS',
      url: new URL(body.pdf?.url ?? '').pathname,
      headers: {
        host: 'localhost:3100',
        origin: 'http://127.0.0.1:3100',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers).toMatchObject({
      'access-control-allow-origin': 'http://127.0.0.1:3100',
      'access-control-allow-methods': 'GET, HEAD',
      'access-control-allow-headers': 'range',
    });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // Not on the app host.
    const app404 = await app.inject({
      method: 'OPTIONS',
      url: new URL(body.pdf?.url ?? '').pathname,
      headers: { host: '127.0.0.1:3100' },
    });
    expect(app404.statusCode).toBe(404);
  });
});
