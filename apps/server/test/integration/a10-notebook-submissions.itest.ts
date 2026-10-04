import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SUBMISSION_BYTES } from '@parallax/contracts/routes/notebookSubmissions';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { auditEvents, classes, notebookSubmissions } from '../../src/db/schema';
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
 * A10 (§10.1, §10.5, §10.7): opening Colab creates no grade and no submission; uploading a
 * notebook creates an explicit, versioned submission with a receipt; the submitted copy stays
 * whatever happens to the external runtime; instructors review the snapshots, students see only
 * their own.
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

/** A notebook as Colab saves it: its own metadata block, outputs stored, nothing to run. */
const colabNotebook = (answer: string) =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      colab: { provenance: [] },
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python', version: '3.11.9' },
    },
    cells: [
      {
        id: 'draw',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        source: `means.std(ddof=1) # ${answer}`,
        outputs: [
          {
            output_type: 'execute_result',
            execution_count: 1,
            metadata: {},
            data: { 'text/plain': answer },
          },
        ],
      },
    ],
  });

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let root: string;
let notebookId: string;
let notebookRevisionId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-submissions-'));
  const course = asCourseScope(ids.statistics, ids.elena);
  const created = await createResource(
    testDb.db,
    course,
    ids.sampling,
    { type: 'notebook', title: 'Repeated samples', content: {} },
    now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  notebookId = created.value.id;
  if (!created.value.headRevisionId) throw new Error('the notebook has no head revision');
  notebookRevisionId = created.value.headRevisionId;
  const published = await publishRelease(testDb.db, course);
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  for (const [classId, instructor] of [
    [ids.classA, ids.priya],
    [ids.classB, ids.marcus],
  ] as const) {
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(classId, ids.statistics, instructor, { releaseId: ids.releaseV1 }),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
  }
  app = await buildApp(config, { db: testDb.db, now: () => now, storage: new FsStorage(root) });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const base = (classId: string, resourceId = notebookId) =>
  `/api/classes/${classId}/resources/${resourceId}`;

async function call(who: PersonName, method: 'GET' | 'POST', url: string) {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

/** The upload as a browser sends it: multipart with one `file` part. */
async function submit(
  who: PersonName,
  file: { name: string; bytes: Buffer | string },
  key: string,
  classId: string = ids.classA,
  resourceId = notebookId,
) {
  const boundary = '----parallax-test-boundary';
  const res = await app.inject({
    method: 'POST',
    url: `${base(classId, resourceId)}/notebook-submissions?submissionKey=${key}`,
    headers: {
      host: '127.0.0.1:3100',
      cookie: world.cookie[who],
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(file.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

/** What the content origin serves for a download link, as the browser asks: host, no cookies. */
const fetchContent = (url: string) =>
  app.inject({ method: 'GET', url: new URL(url).pathname, headers: { host: 'localhost:3100' } });

const rowCount = async () => (await testDb.db.select().from(notebookSubmissions)).length;

describe('Open in Colab', () => {
  test('A10 opening Colab creates no grade and no submission, only a launch event', async () => {
    const launch = await call('sam', 'POST', `${base(ids.classA)}/colab-launch`);
    expect(launch.status).toBe(200);
    expect(launch.body.launchedAt).toBe(now.toISOString());
    expect(await rowCount()).toBe(0);
    const own = await call('sam', 'GET', `${base(ids.classA)}/notebook-submissions/mine`);
    expect(own.body).toEqual({ submissions: [] });
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'notebook.colab_launched'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: ids.sam,
      scopeId: ids.classA,
      targetId: notebookId,
    });
  });

  test('repeated Colab launches of one notebook by one student are one audit row', async () => {
    const again = await call('sam', 'POST', `${base(ids.classA)}/colab-launch`);
    expect(again.status).toBe(200);
    expect(again.body.launchedAt).toBe(now.toISOString());
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'notebook.colab_launched'), eq(auditEvents.actorId, ids.sam)),
      );
    expect(events).toHaveLength(1);
  });

  test('A10 a launch of a resource that is not a notebook of the class is a 404', async () => {
    const missing = await call('sam', 'POST', `${base(ids.classA, ids.estimation)}/colab-launch`);
    expect(missing.status).toBe(404);
    const outsider = await call('bea', 'POST', `${base(ids.classA)}/colab-launch`);
    expect(outsider.status).toBe(404);
  });
});

describe('notebook upload', () => {
  const v1 = colabNotebook('0.60');
  const v2 = colabNotebook('0.30');
  let first: { id: string; sha256: string };

  test('A10 an uploaded notebook becomes version 1 with a receipt naming file, digest and environment', async () => {
    const res = await submit('sam', { name: 'Repeated samples.ipynb', bytes: v1 }, 'sam-key-0001');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.any(String),
      resourceId: notebookId,
      resourceRevisionId: notebookRevisionId,
      version: 1,
      filename: 'Repeated samples.ipynb',
      size: Buffer.byteLength(v1),
      sha256: createHash('sha256').update(v1).digest('hex'),
      environment: {
        runtime: 'colab',
        kernel: 'Python 3',
        language: 'python',
        languageVersion: '3.11.9',
        nbformat: '4.5',
      },
      receivedAt: now.toISOString(),
    });
    first = res.body;
  });

  test('A10 uploading again adds version 2 and keeps version 1 unchanged', async () => {
    const res = await submit('sam', { name: 'Repeated samples.ipynb', bytes: v2 }, 'sam-key-0002');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.id).not.toBe(first.id);
    const own = await call('sam', 'GET', `${base(ids.classA)}/notebook-submissions/mine`);
    expect(own.body.submissions.map((s: { version: number }) => s.version)).toEqual([2, 1]);
    expect(own.body.submissions[1]).toMatchObject({ id: first.id, sha256: first.sha256 });
  });

  test('A10 a repeated request with the same key answers the same receipt and adds no version', async () => {
    const again = await submit(
      'sam',
      { name: 'Repeated samples.ipynb', bytes: v1 },
      'sam-key-0001',
    );
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.id);
    expect(again.body.version).toBe(1);
    expect(await rowCount()).toBe(2);
    const clash = await submit('sam', { name: 'Other.ipynb', bytes: v2 }, 'sam-key-0001');
    expect(clash.status).toBe(400);
    expect(clash.body.message).toMatch(/different file/);
    expect(await rowCount()).toBe(2);
  });

  test('A10 the submitted copy is served unchanged after later versions and cannot be edited or deleted', async () => {
    const link = await call(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/notebook-submissions/${first.id}/download`,
    );
    expect(link.status).toBe(200);
    const served = await fetchContent(link.body.url);
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe(v1);
    expect(served.headers['content-disposition']).toMatch(/attachment; filename.*\.ipynb/);
    await expect(
      testDb.db
        .update(notebookSubmissions)
        .set({ filename: 'edited.ipynb' })
        .where(eq(notebookSubmissions.id, first.id)),
    ).rejects.toThrow();
    await expect(
      testDb.db.delete(notebookSubmissions).where(eq(notebookSubmissions.id, first.id)),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(2);
  });

  test('A10 a file that is not a valid notebook is refused with the reason and nothing is kept', async () => {
    const refusals: [string, Buffer | string, RegExp][] = [
      ['answers.txt', v1, /\.ipynb/],
      ['empty.ipynb', '', /empty/],
      ['broken.ipynb', '{"cells": [', /not valid JSON/],
      ['old.ipynb', JSON.stringify({ nbformat: 3, worksheets: [] }), /Only nbformat 4/],
      ['binary.ipynb', Buffer.from([0x7b, 0x00, 0x7d]), /not text/],
      ['latin1.ipynb', Buffer.from([0x7b, 0xe9, 0x7d]), /UTF-8/],
    ];
    for (const [name, bytes, reason] of refusals) {
      const res = await submit('sam', { name, bytes }, `bad-${name.replace(/\W/g, '')}`);
      expect(res.status, name).toBe(400);
      expect(res.body.error, name).toMatch(reason);
    }
    expect(await rowCount()).toBe(2);
  });

  test('A10 a file over the size limit is refused with 413', async () => {
    const padding = 'x'.repeat(MAX_SUBMISSION_BYTES);
    const res = await submit(
      'sam',
      { name: 'huge.ipynb', bytes: `{"pad":"${padding}"}` },
      'huge-key-0001',
    );
    expect(res.status).toBe(413);
    expect(await rowCount()).toBe(2);
  });
});

describe('who sees what', () => {
  test('A10 an instructor lists every student’s versions with the snapshot link; a student does not', async () => {
    const listing = await call('priya', 'GET', `${base(ids.classA)}/notebook-submissions`);
    expect(listing.status).toBe(200);
    expect(
      listing.body.submissions.map((s: { student: { name: string }; version: number }) => [
        s.student.name,
        s.version,
      ]),
    ).toEqual([
      ['Sam Okafor', 2],
      ['Sam Okafor', 1],
    ]);
    const link = await call(
      'priya',
      'GET',
      `/api/classes/${ids.classA}/notebook-submissions/${listing.body.submissions[1].id}/download`,
    );
    expect(link.status).toBe(200);
    expect((await fetchContent(link.body.url)).statusCode).toBe(200);
    expect((await call('sam', 'GET', `${base(ids.classA)}/notebook-submissions`)).status).toBe(403);
  });

  test('A10 another class’s members cannot list, download or submit into this class', async () => {
    const [mine] = await testDb.db.select().from(notebookSubmissions).limit(1);
    const id = mine?.id ?? '';
    for (const who of ['bea', 'marcus'] as const) {
      expect((await call(who, 'GET', `${base(ids.classA)}/notebook-submissions`)).status).toBe(404);
      expect(
        (await call(who, 'GET', `/api/classes/${ids.classA}/notebook-submissions/${id}/download`))
          .status,
      ).toBe(404);
      expect(
        (await submit(who, { name: 'a.ipynb', bytes: colabNotebook('x') }, 'foreign-key-01'))
          .status,
      ).toBe(404);
    }
    // Asked for through another class the caller belongs to, the same id is not found either.
    const crossClass = await call(
      'bea',
      'GET',
      `/api/classes/${ids.classB}/notebook-submissions/${id}/download`,
    );
    expect(crossClass.status).toBe(404);
    expect(await rowCount()).toBe(2);
  });

  test('A10 a preview principal’s submission never reaches the instructor’s listing', async () => {
    const res = await submit(
      'previewB',
      { name: 'preview.ipynb', bytes: colabNotebook('p') },
      'preview-key-01',
      ids.classB,
    );
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    const listing = await call('marcus', 'GET', `${base(ids.classB)}/notebook-submissions`);
    expect(listing.body).toEqual({ submissions: [] });
    const link = await call(
      'marcus',
      'GET',
      `/api/classes/${ids.classB}/notebook-submissions/${res.body.id}/download`,
    );
    expect(link.status).toBe(404);
    const audit = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'notebook.submitted'));
    expect(audit.every((e) => e.actorId !== ids.previewB)).toBe(true);
  });

  test('A10 an archived class keeps its submissions readable and refuses new ones', async () => {
    await testDb.db.update(classes).set({ archivedAt: now }).where(eq(classes.id, ids.classA));
    try {
      const refused = await submit(
        'sam',
        { name: 'late.ipynb', bytes: colabNotebook('late') },
        'late-key-0001',
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: 'class_archived' });
      const own = await call('sam', 'GET', `${base(ids.classA)}/notebook-submissions/mine`);
      expect(own.body.submissions).toHaveLength(2);
      const launches = () =>
        testDb.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'notebook.colab_launched'));
      const before = (await launches()).length;
      const launch = await call('sam', 'POST', `${base(ids.classA)}/colab-launch`);
      expect(launch.status).toBe(409);
      expect(launch.body).toEqual({ error: 'class_archived' });
      expect(await launches()).toHaveLength(before);
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classA));
    }
  });
});
