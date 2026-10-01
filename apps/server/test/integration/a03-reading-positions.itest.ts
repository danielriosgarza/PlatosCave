import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/content/adoption';
import { renderReading } from '../../src/content/reading';
import { publishRelease } from '../../src/content/releases';
import { resourceRevisions, resources, studyPositions } from '../../src/db/schema';
import { writeDerivedOutputs } from '../../src/jobs/derived';
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
});
const ready = (job: string) => ({
  state: 'ready' as const,
  job,
  jobId: null,
  updatedAt: now.toISOString(),
});

/** The union of what these routes answer, read loosely by the assertions below. */
interface Body {
  readings: { title: string; kind: string; position: unknown }[];
  lastRevisionId: string | null;
  html: string;
  pdf: { url: string; expiresAt: string; pageCount: number };
  updatedAt: string;
  topics: { savedTab: string | null }[];
  resume: unknown;
}

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let root: string;
const rev: Record<'native' | 'figures' | 'pdf' | 'pending', string> = {
  native: '',
  figures: '',
  pdf: '',
  pending: '',
};
let nativeBlock = '';

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
const list = (who: PersonName, classId: string, topicId: string) =>
  call(who, 'GET', `/api/classes/${classId}/topics/${topicId}/readings`);
const read = (who: PersonName, classId: string, revisionId: string) =>
  call(who, 'GET', `/api/classes/${classId}/resources/${revisionId}/reading`);
const save = (who: PersonName, classId: string, body: object) =>
  call(who, 'PUT', `/api/classes/${classId}/positions`, body);

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-positions-'));
  const storage = new FsStorage(root);
  app = await buildApp(config, { db: testDb.db, storage, now: () => now });
  await app.ready();

  const { db } = testDb;
  const elena = asCourseScope(ids.statistics, ids.elena);
  const picture = await storeCourseObject(db, storage, elena, Buffer.from('png'), 'image/png');
  const pdf = await storeCourseObject(db, storage, elena, Buffer.from('%PDF'), 'application/pdf');

  // The seeded reading becomes an ingested one.
  const rendered = renderReading(
    '# Why samples vary\n\nEvery sample tells a slightly different story.\n\nWider samples vary less.',
    'markdown',
    {},
  );
  nativeBlock = one(rendered.blockMap.filter((b) => b.tag === 'p')).id;
  await writeDerivedOutputs(
    db,
    elena,
    ids.samplingReadingV1,
    { ...rendered },
    ready('reading.ingest'),
  );
  rev.native = ids.samplingReadingV1;

  const addReading = async (
    type: 'reading_native' | 'reading_pdf',
    title: string,
    objectKeys: string[],
    position: number,
  ) => {
    const resource = one(
      await db
        .insert(resources)
        .values({
          courseId: ids.statistics,
          topicId: ids.sampling,
          type,
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
          type,
          content: type === 'reading_pdf' ? { title } : { markdown: 'later' },
          ...(type === 'reading_pdf' && { accessibleAlternative: { text: title } }),
          objectKeys,
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
  rev.figures = await addReading('reading_native', 'Figures', [picture.key], 4);
  await writeDerivedOutputs(
    db,
    elena,
    rev.figures,
    {
      ...renderReading('![A histogram](hist.png)\n\nBars show counts.', 'markdown', {
        'hist.png': picture.key,
      }),
    },
    ready('reading.ingest'),
  );
  rev.pdf = await addReading('reading_pdf', 'Sampling paper', [pdf.key], 5);
  await writeDerivedOutputs(
    db,
    elena,
    rev.pdf,
    { pageCount: 3, pages: [] },
    ready('reading.ingest'),
  );
  rev.pending = await addReading('reading_native', 'Still converting', [], 6);

  const published = await publishRelease(db, elena);
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(db, asClassScope(ids.classA, ids.statistics, ids.priya), {
    releaseId: published.release.id,
    expectedReleaseId: ids.releaseV1,
  });
  if (!adopted.ok) throw new Error(adopted.reason);
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('reading list and content', () => {
  test('A03 lists the topic readings in authored order with kind and no position yet', async () => {
    const { status, body } = await list('sam', ids.classA, ids.sampling);
    expect(status).toBe(200);
    expect(body.readings.map((r) => [r.title, r.kind, r.position])).toEqual([
      ['Why samples vary', 'native', null],
      ['Figures', 'native', null],
      ['Sampling paper', 'pdf', null],
      ['Still converting', 'native', null],
    ]);
    expect(body.lastRevisionId).toBeNull();
  });

  test('A03 a native reading comes back as sanitised HTML whose image has a content link', async () => {
    const { status, body } = await read('sam', ids.classA, rev.native);
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'native', status: 'ready', pdf: null, error: null });
    expect(body.html).toContain('Every sample tells a slightly different story.');
    const figures = (await read('sam', ids.classA, rev.figures)).body;
    expect(figures.html).toMatch(/<img [^>]*src="http:\/\/localhost:3100\/content\/[^"]+"/);
    expect(body.html).toContain(`data-block-id="${nativeBlock}"`);
    expect(figures.html).not.toContain(
      'data-object-key="courses/00000000-0000-4000-8000-000000000999',
    );
  });

  test('A03 a PDF reading comes back as a short-lived content link with its page count', async () => {
    const { body } = await read('sam', ids.classA, rev.pdf);
    expect(body).toMatchObject({ kind: 'pdf', status: 'ready', html: null });
    expect(body.pdf.pageCount).toBe(3);
    expect(body.pdf.url).toMatch(/^http:\/\/localhost:3100\/content\//);
    expect(Date.parse(body.pdf.expiresAt)).toBeGreaterThan(now.getTime());
  });

  test('A03 a reading still being processed says so instead of showing empty content', async () => {
    const { status, body } = await read('sam', ids.classA, rev.pending);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'pending', html: null, pdf: null });
  });

  test('A01 a reading outside the class release, a locked topic or another class is a 404', async () => {
    // The answer key is hidden from students and sits in a prerequisite-locked topic.
    expect((await read('sam', ids.classA, ids.answerKeyV1)).status).toBe(404);
    expect((await list('sam', ids.classA, ids.estimation)).status).toBe(404);
    expect((await read('priya', ids.classA, ids.answerKeyV1)).status).toBe(200);
    // Class B stays on release v1: it has neither new reading.
    expect((await read('bea', ids.classB, rev.pdf)).status).toBe(404);
    expect((await list('bea', ids.classB, ids.sampling)).body.readings).toHaveLength(1);
    // A non-member learns nothing, and a quiz is not a reading.
    expect((await read('bea', ids.classA, rev.native)).status).toBe(404);
    expect((await read('sam', ids.classA, ids.samplingQuizV1)).status).toBe(404);
  });
});

describe('study positions', () => {
  test('A03 a saved position comes back with the list, and the last reading studied is named', async () => {
    const put = await save('sam', ids.classA, {
      revisionId: rev.native,
      tab: 'reading',
      position: { blockId: nativeBlock, offset: 12 },
    });
    expect(put.status).toBe(200);
    expect(put.body.updatedAt).toBe(now.toISOString());
    const { body } = await list('sam', ids.classA, ids.sampling);
    expect(body.readings[0]?.position).toEqual({ blockId: nativeBlock, offset: 12 });
    expect(body.lastRevisionId).toBe(rev.native);
  });

  test('A03 saving again replaces the place instead of adding a row, per reading', async () => {
    await save('sam', ids.classA, {
      revisionId: rev.native,
      tab: 'reading',
      position: { blockId: nativeBlock, offset: 40 },
    });
    await save('sam', ids.classA, {
      revisionId: rev.pdf,
      tab: 'reading',
      position: { page: 2, offset: 350 },
    });
    const rows = await testDb.db
      .select()
      .from(studyPositions)
      .where(and(eq(studyPositions.userId, ids.sam), eq(studyPositions.classId, ids.classA)));
    expect(rows).toHaveLength(2);
    const { body } = await list('sam', ids.classA, ids.sampling);
    expect(body.readings.map((r) => r.position)).toEqual([
      { blockId: nativeBlock, offset: 40 },
      null,
      { page: 2, offset: 350 },
      null,
    ]);
  });

  test('A03 the saved reading tab becomes the topic tab Resume opens', async () => {
    const topics = await call('sam', 'GET', `/api/classes/${ids.classA}/topics`);
    expect(topics.body.topics[0]?.savedTab).toBe('reading');
    expect(topics.body.resume).toMatchObject({ topicId: ids.sampling, tab: 'reading' });
  });

  test('A03 one person’s place is never shown to another', async () => {
    const { body } = await list('priya', ids.classA, ids.sampling);
    expect(body.readings.map((r) => r.position)).toEqual([null, null, null, null]);
    expect(body.lastRevisionId).toBeNull();
  });

  test('A03 a position that does not fit the reading is refused', async () => {
    const bad = (position: object, revisionId = rev.native, tab = 'reading') =>
      save('sam', ids.classA, { revisionId, tab, position });
    expect((await bad({ blockId: 'no-such-block', offset: 0 })).status).toBe(400);
    expect((await bad({ page: 1, offset: 0 })).status).toBe(400);
    expect((await bad({ blockId: nativeBlock, offset: 0 }, rev.pdf)).status).toBe(400);
    expect((await bad({ page: 4, offset: 0 }, rev.pdf)).status).toBe(400);
    expect((await bad({ page: 1, offset: 5000 }, rev.pdf)).status).toBe(400);
    expect((await bad({ blockId: nativeBlock, offset: 0 }, rev.native, 'slides')).status).toBe(400);
  });

  test('A01 a position cannot be saved for a hidden, foreign or unknown resource', async () => {
    const at = (revisionId: string, who: PersonName = 'sam', classId: string = ids.classA) =>
      save(who, classId, {
        revisionId,
        tab: 'reading',
        position: { blockId: 'x', offset: 0 },
      });
    expect((await at(ids.answerKeyV1)).status).toBe(404);
    expect((await at(rev.pdf, 'bea', ids.classB)).status).toBe(404);
    expect((await at(rev.native, 'bea', ids.classA)).status).toBe(404);
    expect((await at('00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });
});
