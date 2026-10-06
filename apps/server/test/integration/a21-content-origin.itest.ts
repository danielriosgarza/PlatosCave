import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { PREVIEW_RETURN_COOKIE } from '../../src/auth/preview';
import { SESSION_COOKIE } from '../../src/auth/sessions';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { renderReading } from '../../src/content/reading';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import { type DerivedStatus, writeDerivedOutputs } from '../../src/db/jobs/derived';
import { resourceRevisions, resources, topics } from '../../src/db/schema';
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
const tomorrow = new Date('2026-10-02T09:00:00Z');
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
let storage: FsStorage;
let clock = now;

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('no row');
  return row;
}

const elenaScope = asCourseScope(ids.statistics, ids.elena);

interface Fixture {
  revisionId: string;
  key: string;
}
const fx = {} as Record<'visible' | 'hidden' | 'scheduled' | 'draft' | 'foreign', Fixture>;

/** A native reading uploaded as Markdown with one figure, and the keys of both files. */
interface NativeFixture {
  revisionId: string;
  source: Fixture;
  figure: Fixture;
}
const native = {} as Record<'ready' | 'failed' | 'pending', NativeFixture>;
const status = (state: DerivedStatus['state'], error?: string): DerivedStatus => ({
  state,
  job: 'reading.ingest',
  // A pending status names a job, so it stays pending rather than reading as never sent.
  jobId: state === 'queued' ? '00000000-0000-4000-8000-0000000000aa' : null,
  updatedAt: now.toISOString(),
  ...(error && { error }),
});

/** Status writes that follow the release (a conversion re-run that fails or is in progress). */
const later: (() => Promise<void>)[] = [];

async function nativeReading(
  topicId: string,
  title: string,
  position: number,
  state: 'ready' | 'failed' | 'queued',
): Promise<NativeFixture> {
  const { db } = testDb;
  const markdown = `# ${title}\n\n![A histogram](fig.png)\n`;
  const source = await storeCourseObject(
    db,
    storage,
    elenaScope,
    Buffer.from(markdown),
    'text/markdown',
  );
  const figure = await storeCourseObject(
    db,
    storage,
    elenaScope,
    Buffer.from(`${title} figure`),
    'image/png',
  );
  const resource = one(
    await db
      .insert(resources)
      .values({
        courseId: ids.statistics,
        topicId,
        type: 'reading_native',
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
        type: 'reading_native',
        content: { sourceKey: source.key, format: 'markdown', assets: { 'fig.png': figure.key } },
        accessibleAlternative: { text: title },
        objectKeys: [source.key, figure.key],
        contentHash: source.sha256,
        createdBy: ids.elena,
      })
      .returning(),
  );
  await db
    .update(resources)
    .set({ headRevisionId: revision.id })
    .where(eq(resources.id, resource.id));
  // Converted for release; `state` is applied after release, as a re-run of the job can.
  const written = await writeDerivedOutputs(
    db,
    elenaScope,
    revision.id,
    { ...renderReading(markdown, 'markdown', { 'fig.png': figure.key }) },
    status('ready'),
  );
  if (!written) throw new Error('derived outputs not written');
  later.push(async () => {
    if (state === 'ready') return;
    const error = state === 'failed' ? 'The file could not be read' : undefined;
    await writeDerivedOutputs(db, elenaScope, revision.id, { html: null }, status(state, error));
  });
  return {
    revisionId: revision.id,
    source: { revisionId: revision.id, key: source.key },
    figure: { revisionId: revision.id, key: figure.key },
  };
}

/** A draft PDF reading whose revision holds one stored object. */
async function resourceWithObject(
  topicId: string,
  title: string,
  bytes: string,
  draft: {
    position?: number;
    visibility?: 'visible' | 'hidden';
    releaseAt?: Date;
  } = {},
  courseId: string = ids.statistics,
  owner: string = ids.elena,
): Promise<Fixture & { resourceId: string }> {
  const { db } = testDb;
  const scope = asCourseScope(courseId, owner);
  const stored = await storeCourseObject(db, storage, scope, Buffer.from(bytes), 'application/pdf');
  const resource = one(
    await db
      .insert(resources)
      .values({
        courseId,
        topicId,
        type: 'reading_pdf',
        title,
        position: draft.position ?? 0,
        createdBy: owner,
        ...(draft.visibility && { visibility: draft.visibility }),
        ...(draft.releaseAt && { releaseAt: draft.releaseAt }),
      })
      .returning(),
  );
  const revision = one(
    await db
      .insert(resourceRevisions)
      .values({
        resourceId: resource.id,
        courseId,
        type: 'reading_pdf',
        content: { title },
        accessibleAlternative: { text: title },
        objectKeys: [stored.key],
        contentHash: stored.sha256,
        createdBy: owner,
      })
      .returning(),
  );
  await db
    .update(resources)
    .set({ headRevisionId: revision.id })
    .where(eq(resources.id, resource.id));
  return { resourceId: resource.id, revisionId: revision.id, key: stored.key };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  root = await mkdtemp(join(tmpdir(), 'parallax-a21-'));
  storage = new FsStorage(root);
  app = await buildApp(config, {
    db: testDb.db,
    storage,
    now: () => clock,
  });
  await app.ready();

  const { db } = testDb;
  const topic = one(
    await db
      .insert(topics)
      .values({
        courseId: ids.statistics,
        position: 2,
        title: 'Inference',
        createdBy: ids.elena,
      })
      .returning(),
  );
  const visible = await resourceWithObject(topic.id, 'Lecture notes', 'visible pdf');
  const hidden = await resourceWithObject(topic.id, 'Answer key', 'hidden pdf', {
    position: 1,
    visibility: 'hidden',
  });
  const scheduled = await resourceWithObject(topic.id, 'Week 2', 'scheduled pdf', {
    position: 2,
    releaseAt: tomorrow,
  });
  native.ready = await nativeReading(topic.id, 'Converted notes', 3, 'ready');
  native.failed = await nativeReading(topic.id, 'Broken notes', 4, 'failed');
  native.pending = await nativeReading(topic.id, 'Converting notes', 5, 'queued');
  const foreignTopic = one(
    await db
      .insert(topics)
      .values({
        courseId: ids.linearModels,
        position: 0,
        title: 'OLS',
        createdBy: ids.olivia,
      })
      .returning(),
  );
  fx.foreign = await resourceWithObject(
    foreignTopic.id,
    'OLS notes',
    'foreign pdf',
    {},
    ids.linearModels,
    ids.olivia,
  );

  // Release v2 of Statistical thinking carries these resources; only class A adopts it, so
  // class B stays on the world's v1, which has none of them.
  const published = await publishRelease(db, elenaScope, { runtimes: DEV_RUNNER_RUNTIMES });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(db, asClassScope(ids.classA, ids.statistics, ids.priya), {
    releaseId: published.release.id,
    expectedReleaseId: ids.releaseV1,
  });
  if (!adopted.ok) throw new Error(adopted.reason);
  for (const write of later) await write();
  fx.visible = visible;
  fx.hidden = hidden;
  fx.scheduled = scheduled;

  // A newer draft revision of the visible resource that no release pins.
  const draftObject = await storeCourseObject(
    db,
    storage,
    elenaScope,
    Buffer.from('draft pdf'),
    'application/pdf',
  );
  const draft = one(
    await db
      .insert(resourceRevisions)
      .values({
        resourceId: visible.resourceId,
        courseId: ids.statistics,
        type: 'slides_pdf',
        content: { title: 'draft' },
        objectKeys: [draftObject.key],
        contentHash: draftObject.sha256,
        createdBy: ids.elena,
      })
      .returning(),
  );
  fx.draft = { revisionId: draft.id, key: draftObject.key };
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const appHost = { host: '127.0.0.1:3100' };
const mintUrl = (classId: string, f: Fixture, query = '') =>
  `/api/classes/${classId}/resources/${f.revisionId}/objects/${encodeURIComponent(f.key)}${query}`;

async function mint(classId: string, f: Fixture, who?: PersonName, query = '') {
  return app.inject({
    method: 'GET',
    url: mintUrl(classId, f, query),
    headers: { ...appHost, ...(who && { cookie: world.cookie[who] }) },
  });
}

/** Follows a minted URL exactly as a browser on the app origin would: no app cookies. */
async function follow(url: string, headers: Record<string, string> = {}) {
  const target = new URL(url);
  return app.inject({
    method: 'GET',
    url: target.pathname,
    headers: { host: target.host, ...headers },
  });
}

describe('content origin and signed content tokens', () => {
  test('A21 a student mints a short-lived content-origin URL for released media of their own class', async () => {
    const res = await mint(ids.classA, fx.visible, 'sam');
    expect(res.statusCode).toBe(200);
    const { url, expiresAt } = res.json();
    expect(url).toMatch(/^http:\/\/localhost:3100\/content\/[\w-]+\.[\w-]+$/);
    expect(expiresAt).toBe('2026-10-01T09:05:00.000Z');

    const file = await follow(url);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('visible pdf');
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-security-policy']).toMatch(/^sandbox; /);
    // The app origin does not serve content URLs, even with a valid token.
    const onApp = await app.inject({
      method: 'GET',
      url: new URL(url).pathname,
      headers: { ...appHost, cookie: world.cookie.sam },
    });
    expect(onApp.statusCode).toBe(404);
  });

  test('A21 the other cohort cannot mint or reach class A media; course ownership is not class access', async () => {
    for (const who of ['bea', 'marcus', 'previewB', 'elena', 'olivia'] as const) {
      const res = await mint(ids.classA, fx.visible, who);
      expect(res.statusCode, who).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    }
    // Class B is on release v1, which does not pin these revisions: not reachable through it.
    expect((await mint(ids.classB, fx.visible, 'bea')).statusCode).toBe(404);
    expect((await mint(ids.classB, fx.visible, 'marcus')).statusCode).toBe(404);
    expect((await mint(ids.classB, fx.visible, 'priya')).statusCode).toBe(404);
    // Another course's object cannot be named through class A's release.
    expect((await mint(ids.classA, fx.foreign, 'priya')).statusCode).toBe(404);
  });

  test('A01 a student is denied downloads of hidden, scheduled and unreleased material', async () => {
    for (const f of [fx.hidden, fx.scheduled, fx.draft]) {
      const res = await mint(ids.classA, f, 'sam');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not found' });
    }
    // An object of the release named under the wrong revision is not reachable either.
    expect(
      (await mint(ids.classA, { revisionId: fx.visible.revisionId, key: fx.hidden.key }, 'sam'))
        .statusCode,
    ).toBe(404);
    // The class instructor previews hidden and scheduled resources, but not drafts.
    expect((await mint(ids.classA, fx.hidden, 'priya')).statusCode).toBe(200);
    expect((await mint(ids.classA, fx.scheduled, 'priya')).statusCode).toBe(200);
    expect((await mint(ids.classA, fx.draft, 'priya')).statusCode).toBe(404);
    // Refused just before the release time, served at it and after it.
    try {
      clock = new Date(tomorrow.getTime() - 1);
      expect((await mint(ids.classA, fx.scheduled, 'sam')).statusCode).toBe(404);
      clock = tomorrow;
      expect((await mint(ids.classA, fx.scheduled, 'sam')).statusCode).toBe(200);
      clock = new Date(tomorrow.getTime() + 1000);
      expect((await mint(ids.classA, fx.scheduled, 'sam')).statusCode).toBe(200);
    } finally {
      clock = now;
    }
  });

  test('A01 without a session nothing is minted; copied links expire and app cookies grant nothing', async () => {
    expect((await mint(ids.classA, fx.visible)).statusCode).toBe(401);
    const { url } = (await mint(ids.classA, fx.visible, 'sam')).json();
    // A session cookie on the content origin does not replace the token.
    const bare = await follow('http://localhost:3100/content/', {
      cookie: world.cookie.sam,
    });
    expect(bare.statusCode).toBe(404);
    const api = await follow('http://localhost:3100/api/me', {
      cookie: world.cookie.sam,
    });
    expect(api.statusCode).toBe(404);
    clock = new Date(now.getTime() + 5 * 60_000);
    try {
      const expired = await follow(url);
      expect(expired.statusCode).toBe(404);
      expect(expired.body).not.toContain('visible pdf');
    } finally {
      clock = now;
    }
  });

  test('downloads are served as attachments named after the resource', async () => {
    const res = await mint(ids.classA, fx.visible, 'sam', '?disposition=attachment');
    const file = await follow(res.json().url);
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="Lecture notes.pdf"; filename*=UTF-8''Lecture%20notes.pdf`,
    );
  });

  test('A21 a native reading serves its figures but not its uploaded source once converted', async () => {
    const source = await mint(ids.classA, native.ready.source, 'sam');
    expect(source.statusCode).toBe(404);
    // The same body as any key the revision does not own.
    const unknown = await mint(
      ids.classA,
      {
        revisionId: native.ready.revisionId,
        key: `courses/${ids.statistics}/objects/${'0'.repeat(64)}`,
      },
      'sam',
    );
    expect(unknown.statusCode).toBe(404);
    expect(source.json()).toEqual(unknown.json());
    expect(source.json()).toEqual({ error: 'not found' });
    // Nor while it is still converting, as an attachment, or for the class instructor.
    expect((await mint(ids.classA, native.pending.source, 'sam')).statusCode).toBe(404);
    expect(
      (await mint(ids.classA, native.ready.source, 'sam', '?disposition=attachment')).statusCode,
    ).toBe(404);
    expect((await mint(ids.classA, native.ready.source, 'priya')).statusCode).toBe(404);

    // Its figures and PDF readings are still served.
    const figure = await mint(ids.classA, native.ready.figure, 'sam');
    expect(figure.statusCode).toBe(200);
    expect((await follow(figure.json().url)).body).toBe('Converted notes figure');
    const pdf = await mint(ids.classA, fx.visible, 'sam');
    expect((await follow(pdf.json().url)).body).toBe('visible pdf');
  });

  test('A21 a failed conversion offers its uploaded source as the permitted download', async () => {
    const res = await mint(ids.classA, native.failed.source, 'sam', '?disposition=attachment');
    expect(res.statusCode).toBe(200);
    const file = await follow(res.json().url);
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('# Broken notes');
    expect(file.headers['content-disposition']).toMatch(/^attachment; /);
    expect(file.headers['content-security-policy']).toMatch(/^sandbox; /);
    // The other cohort still cannot reach it.
    expect((await mint(ids.classA, native.failed.source, 'bea')).statusCode).toBe(404);
  });

  test('A01 the reading names its source only when the student may download it', async () => {
    const read = async (revisionId: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/classes/${ids.classA}/resources/${revisionId}/reading`,
          headers: { ...appHost, cookie: world.cookie.sam },
        })
      ).json();
    expect(await read(native.ready.revisionId)).toMatchObject({
      status: 'ready',
      sourceKey: null,
    });
    expect(await read(native.pending.revisionId)).toMatchObject({
      status: 'pending',
      sourceKey: null,
    });
    expect(await read(native.failed.revisionId)).toMatchObject({
      status: 'failed',
      sourceKey: native.failed.source.key,
    });
    expect(await read(fx.visible.revisionId)).toMatchObject({ sourceKey: fx.visible.key });
  });

  test('A01 a draft preview follows the same rule for a native reading source', async () => {
    const started = await app.inject({
      method: 'POST',
      url: `/api/courses/${ids.statistics}/preview`,
      headers: { ...appHost, cookie: world.cookie.marcus },
      payload: { classId: ids.classB, topicId: ids.sampling },
    });
    expect(started.statusCode).toBe(200);
    const cookie = started.cookies
      .filter((c) => c.name === SESSION_COOKIE || c.name === PREVIEW_RETURN_COOKIE)
      .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
      .join('; ');
    const preview = (f: Fixture) =>
      app.inject({ method: 'GET', url: mintUrl(ids.classB, f), headers: { ...appHost, cookie } });
    expect((await preview(native.ready.figure)).statusCode).toBe(200);
    expect((await preview(native.ready.source)).statusCode).toBe(404);
    expect((await preview(native.failed.source)).statusCode).toBe(200);
  });
});
