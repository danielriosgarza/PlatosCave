import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { createBoss } from '../../src/db/jobs/boss';
import { resourceRevisions, storageObjects } from '../../src/db/schema';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { ensureQueues, workScopedJob } from '../../src/jobs/scoped';
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

/**
 * A09 (§10.1, §10.7): a notebook is imported against the nbformat contract, rendered with its
 * stored outputs and never run; HTML outputs reach the browser only as sandboxed documents on
 * the content origin, and outputs are labelled as stored, not live.
 */

const now = new Date('2026-10-01T09:00:00Z');
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
});
const course = `/api/courses/${ids.statistics}`;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const hostileHtml =
  '<div id="chart">Sample means<script>fetch("/api/me",{credentials:"include"}).then(r=>r.text()).then(t=>parent.postMessage(t,"*"))</script>' +
  '<img src="x" onerror="alert(document.cookie)"></div>';

const notebookFile = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3' },
    language_info: { name: 'python' },
  },
  cells: [
    {
      id: 'intro',
      cell_type: 'markdown',
      metadata: {},
      source: '# Repeated samples\n\nDraw 1,000 samples.',
    },
    {
      id: 'draw',
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: 'means.std(ddof=1)',
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 1,
          metadata: {},
          data: { 'text/plain': '0.60' },
        },
      ],
    },
    {
      id: 'html',
      cell_type: 'code',
      metadata: {},
      execution_count: 2,
      source: 'display(HTML(chart))',
      outputs: [
        { output_type: 'display_data', metadata: {}, data: { 'text/html': hostileHtml } },
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG, 'text/plain': 'Histogram of means' },
        },
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'application/javascript': 'alert(1)' },
        },
      ],
    },
  ],
});

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let boss: PgBoss;
let root: string;
let storage: FsStorage;
let revisionId = '';
let sourceKey = '';

const api = async (who: PersonName, method: 'GET' | 'POST', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
};

function upload(filename: string, text: string) {
  const boundary = '----parallax-test-boundary';
  return app.inject({
    method: 'POST',
    url: `${course}/uploads`,
    headers: {
      host: '127.0.0.1:3100',
      cookie: world.cookie.elena,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(text),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

/** GET of a content-origin URL as the browser sends it: the content host, no cookies. */
const content = (url: string, host = 'localhost:3100') =>
  app.inject({ method: 'GET', url: new URL(url).pathname, headers: { host } });

const notebookOf = (who: PersonName, classId = ids.classA) =>
  api(who, 'GET', `/api/classes/${classId}/resources/${revisionId}/notebook`);

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-notebooks-'));
  storage = new FsStorage(root);
  boss = createBoss(testDb.db.$client, { role: 'api', onError: () => {}, onWarning: () => {} });
  await boss.start();
  await ensureQueues(boss, [readingIngest]);
  app = await buildApp(config, { db: testDb.db, now: () => now, storage, boss });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('notebook import', () => {
  test('A09 an .ipynb that is not a valid nbformat 4 notebook is refused and not stored', async () => {
    const before = await testDb.db.select().from(storageObjects);
    const notJson = await upload('broken.ipynb', '{"cells": [');
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json().message).toMatch(/not valid JSON/);
    const v3 = await upload('old.ipynb', JSON.stringify({ nbformat: 3, worksheets: [] }));
    expect(v3.statusCode).toBe(400);
    expect(v3.json().message).toMatch(/Only nbformat 4/);
    const noOutputs = await upload(
      'bad.ipynb',
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ id: 'a', cell_type: 'code', metadata: {}, source: '', execution_count: null }],
      }),
    );
    expect(noOutputs.statusCode).toBe(400);
    expect(noOutputs.json().message).toMatch(/cells\.0\.outputs/);
    expect(await testDb.db.select().from(storageObjects)).toHaveLength(before.length);
  });

  test('A09 a valid notebook is stored, imported by the worker without running it, and published', async () => {
    const uploaded = await upload('Repeated samples.ipynb', notebookFile);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      format: 'notebook',
      filename: 'Repeated samples.ipynb',
    });
    sourceKey = uploaded.json().key;

    const created = await api('elena', 'POST', `${course}/topics/${ids.sampling}/resources`, {
      type: 'notebook',
      title: 'Repeated samples',
      content: { sourceKey },
      objectKeys: [sourceKey],
    });
    expect(created.status).toBe(200);
    revisionId = created.body.headRevisionId;
    void workScopedJob(
      boss,
      testDb.db,
      readingIngest,
      { info: () => {}, warn: () => {}, error: () => {} },
      { pollingIntervalSeconds: 0.5 },
      { storage },
    );
    let derived: Record<string, unknown> = {};
    for (let i = 0; i < 80; i += 1) {
      const [row] = await testDb.db
        .select({ derived: resourceRevisions.derived })
        .from(resourceRevisions)
        .where(eq(resourceRevisions.id, revisionId));
      derived = row?.derived ?? {};
      const state = (derived.status as { state?: string } | undefined)?.state;
      if (state === 'ready' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(derived.status).toMatchObject({ state: 'ready' });
    // Two output objects: the HTML document and the image.
    expect(Object.values(derived.objects as object).sort()).toEqual([
      'image/png',
      'text/html; charset=utf-8',
    ]);

    const elena = asCourseScope(ids.statistics, ids.elena);
    const published = await publishRelease(testDb.db, elena);
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(ids.classA, ids.statistics, ids.priya),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
  });
});

describe('A09 rendered notebook', () => {
  test('A09 a student sees the cells with stored outputs, labelled with the kernel they came from', async () => {
    const list = await api(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/topics/${ids.sampling}/notebooks`,
    );
    expect(list.status).toBe(200);
    expect(list.body.notebooks).toEqual([
      { resourceId: expect.any(String), revisionId, title: 'Repeated samples', type: 'notebook' },
    ]);

    const { status, body } = await notebookOf('sam');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', error: null, sourceKey });
    expect(body.notebook.kernel).toBe('Python 3');
    expect(body.notebook.outline).toEqual([
      { cellId: 'intro', level: 1, text: 'Repeated samples' },
    ]);
    const [intro, draw, html] = body.notebook.cells;
    expect(intro).toMatchObject({
      type: 'markdown',
      html: expect.stringContaining('Draw 1,000 samples.'),
    });
    expect(draw).toMatchObject({ type: 'code', executionCount: 1, source: 'means.std(ddof=1)' });
    expect(draw.outputs).toEqual([
      { type: 'text', executionCount: 1, stream: null, text: '0.60', truncated: false },
    ]);
    expect(html.outputs.map((o: { type: string }) => o.type)).toEqual([
      'html',
      'image',
      'unsupported',
    ]);
  });

  test('A09 the response for the app origin carries no part of an HTML output; it links to the content origin', async () => {
    const { body } = await notebookOf('sam');
    const text = JSON.stringify(body);
    expect(text).not.toContain('<script');
    expect(text).not.toContain('onerror');
    const [frame, image] = body.notebook.cells[2].outputs;
    expect(frame).toMatchObject({ type: 'html', scriptsRemoved: true });
    expect(frame.url).toMatch(/^http:\/\/localhost:3100\/content\//);
    expect(image).toMatchObject({ type: 'image', alt: 'Histogram of means' });
    expect(image.url).toMatch(/^http:\/\/localhost:3100\/content\//);
  });

  test('A09 the HTML output is served sandboxed, script-free and without cookies on the content origin', async () => {
    const { body } = await notebookOf('sam');
    const [frame, image] = body.notebook.cells[2].outputs;
    const res = await content(frame.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(res.headers['content-security-policy']);
    expect(csp.split(';')[0]).toBe('sandbox');
    expect(csp).not.toContain('allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('Sample means');
    expect(res.body).not.toMatch(/<script|onerror|fetch\(/i);
    // The same token on the app host does not exist.
    expect((await content(frame.url, '127.0.0.1:3100')).statusCode).toBe(404);
    const png = await content(image.url);
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
  });

  test('A09 another class, a non-member and the source download follow class scope', async () => {
    // Class B is still on the release without the notebook; its student sees nothing of it.
    expect((await notebookOf('bea', ids.classB)).status).toBe(404);
    expect((await notebookOf('bea', ids.classA)).status).toBe(404);
    expect((await notebookOf('olivia')).status).toBe(404);
    expect((await notebookOf('priya')).status).toBe(200);
    const download = await api(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/resources/${revisionId}/objects/${encodeURIComponent(sourceKey)}?disposition=attachment`,
    );
    expect(download.status).toBe(200);
    const file = await content(download.body.url);
    expect(file.headers['content-disposition']).toContain('Repeated samples.ipynb');
    expect(JSON.parse(file.body)).toMatchObject({ nbformat: 4 });
  });

  test('A09 a reading or a deck is not a notebook', async () => {
    const reading = await api(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/resources/${ids.samplingReadingV1}/notebook`,
    );
    expect(reading.status).toBe(404);
  });
});
