import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import type { CourseScope } from '../../src/auth/scope';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { folderRowId } from '../../src/content/folder-ids';
import { convertAndPublish, type PublishDeps } from '../../src/content/publish-drafts';
import { createSession } from '../../src/db/auth/sessions';
import { createResource, createTopic } from '../../src/db/content/drafts';
import { validateDrafts } from '../../src/db/content/releases';
import {
  draftFingerprint,
  ensureFolderCourse,
  type FolderOwner,
  withSyncDatabase,
} from '../../src/db/content/sync';
import { createUser } from '../../src/db/identity';
import { createBoss } from '../../src/db/jobs/boss';
import { listResourceJobStatus } from '../../src/db/jobs/derived';
import { auditEvents, courseReleases } from '../../src/db/schema';
import readingIngest from '../../src/jobs/reading-ingest.job';
import { loadJobs } from '../../src/jobs/registry';
import { ensureQueues, workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { cookieFor } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

// Steps 6 to 8 of `parallax sync` (docs/design/course-folder.md §10) on real PostgreSQL: the
// fingerprint, the conversion and the publication, with a worker started as
// reading-ingest.itest.ts starts one. The fixtures follow the design's fictional course
// "Reef ecology" by Ana Lima.

const ANA = 'ana.lima@example.org';
const validate = { approvedShinyOrigins: [], runtimes: DEV_RUNNER_RUNTIMES };
const deck = { markdown: '# Transects\n\n---\n\n# Quadrats' };
const bossErrors: Error[] = [];
const handlers = { onError: (err: Error) => bossErrors.push(err), onWarning: () => {} };

let testDb: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let root: string;
let ana: FolderOwner;
let cookie: string;
let deps: PublishDeps;
let auditBefore: string[];

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ana = { id: await createUser(db, { email: ANA, name: 'Ana Lima' }), email: ANA };
  cookie = cookieFor((await createSession(db, ana.id)).token);
  auditBefore = (await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), { db });
  boss = createBoss(db.$client, { role: 'api', ...handlers });
  await boss.start();
  // As the API does at startup: sends never create the queue themselves.
  await ensureQueues(boss, await loadJobs());
  root = await mkdtemp(join(tmpdir(), 'parallax-folder-'));
  // A worker that never takes the job ends the wait as `unfinished` before the test's time limit.
  deps = { db, boss, validate, wait: { idleMs: 20_000, pollMs: 200 } };
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await testDb?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

let made = 0;
/** One of Ana's folder courses with one resource, and the drafts' fingerprint after the writes. */
async function folderCourse(
  type: 'slides_web' | 'reading_native' = 'slides_web',
  content: Record<string, unknown> = deck,
) {
  const { db } = testDb;
  const course = await ensureFolderCourse(db, ana, `reef-${made++}`, 'Reef', [ANA]);
  if (!course.ok) throw new Error(course.reason);
  const { scope } = course;
  const topicId = folderRowId(scope.courseId, 'topic', 'sampling');
  await createTopic(db, scope, { id: topicId, title: 'Sampling' }, new Date());
  const resourceId = folderRowId(scope.courseId, 'resource', 'transects');
  const input = { id: resourceId, type, title: 'Transects', content };
  const created = await createResource(db, scope, topicId, input, new Date());
  if (!created.ok) throw new Error(created.reason);
  return { scope, resourceId, fingerprint: await draftFingerprint(db, scope) };
}

const versions = async ({ courseId }: CourseScope) => {
  const rows = await testDb.db
    .select()
    .from(courseReleases)
    .where(eq(courseReleases.courseId, courseId));
  return rows.map((r) => r.version);
};
const stateOf = async (scope: CourseScope) =>
  (await listResourceJobStatus(testDb.db, scope))[0]?.status?.state;

// Each conversion starts a thread that compiles the rendering pipeline (about 2 s on Windows),
// and the conflict test also starts the worker: more time than the suite's default per test.
describe('conversion and publication of a folder course', { timeout: 30_000 }, () => {
  test('with no worker convertAndPublish returns its not-finished result within the idle bound', async () => {
    const { scope, fingerprint } = await folderCourse();
    const idleMs = 1_500;
    // The handle and the queue of the sync script: the job it sends, no worker takes.
    const { result, took } = await withSyncDatabase(testDb.url, handlers, async (db, queue) => {
      const started = Date.now();
      const wait = { idleMs, pollMs: 100 };
      const outcome = await convertAndPublish(
        { db, boss: queue, validate, wait },
        scope,
        fingerprint,
      );
      return { result: outcome, took: Date.now() - started };
    });
    expect(took).toBeGreaterThanOrEqual(idleMs);
    expect(took).toBeLessThan(idleMs + 2_000);
    const report = await validateDrafts(testDb.db, scope, validate);
    expect(result).toEqual({ status: 'unfinished', reason: 'idle', report });
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: 'unprocessed_reading',
        message: '“Transects” is still being processed',
      }),
    ]);
    expect(await stateOf(scope)).toBe('queued');
    expect(await versions(scope)).toEqual([]);
  });

  test('a draft saved through the resource route while convertAndPublish waits for a conversion ends it as a conflict and leaves no release', async () => {
    const { scope, resourceId, fingerprint } = await folderCourse();
    const waiting = convertAndPublish(deps, scope, fingerprint);
    for (let i = 0; i < 100 && !(await stateOf(scope)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/courses/${scope.courseId}/resources/${resourceId}`,
      headers: { cookie },
      payload: { expectedRevision: 1, title: 'Transects, revised' },
    });
    expect(res.statusCode).toBe(200);
    // The worker comes only now, and stays for the tests below.
    await workScopedJob(
      boss,
      testDb.db,
      readingIngest,
      app.log,
      { pollingIntervalSeconds: 0.5 },
      { storage: new FsStorage(root), boss },
    );
    expect(await waiting).toEqual({ status: 'conflict' });
    expect(await stateOf(scope)).toBe('ready');
    expect(await versions(scope)).toEqual([]);
  });

  test('convertAndPublish publishes release 1 when every head is ready, and a second call makes no release', async () => {
    const { scope, fingerprint } = await folderCourse();
    const first = await convertAndPublish(deps, scope, fingerprint);
    expect(first).toMatchObject({ status: 'published', release: { version: 1 } });
    expect(await stateOf(scope)).toBe('ready');
    const again = await draftFingerprint(testDb.db, scope);
    expect(await convertAndPublish(deps, scope, again)).toEqual({ status: 'unchanged' });
    expect(await versions(scope)).toEqual([1]);
  });

  test('a failed conversion returns the report of validateDrafts and leaves no release', async () => {
    const source = { sourceKey: 'courses/elsewhere/objects/x', format: 'html' };
    const { scope, fingerprint } = await folderCourse('reading_native', source);
    const result = await convertAndPublish(deps, scope, fingerprint);
    const report = await validateDrafts(testDb.db, scope, validate);
    expect(result).toEqual({ status: 'blocked', report });
    expect(report.errors).toEqual([expect.objectContaining({ code: 'unprocessed_reading' })]);
    expect(await stateOf(scope)).toBe('failed');
    expect(await versions(scope)).toEqual([]);
  });

  test('two calls of convertAndPublish started together leave one release', async () => {
    const { scope, fingerprint } = await folderCourse();
    const both = await Promise.all([
      convertAndPublish(deps, scope, fingerprint),
      convertAndPublish(deps, scope, fingerprint),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(['published', 'unchanged']);
    expect(await versions(scope)).toEqual([1]);
  });

  test('audit_events gains only the rows of createCourse and publishRelease', async () => {
    const added = await testDb.db
      .select()
      .from(auditEvents)
      .where(notInArray(auditEvents.id, auditBefore));
    expect(added.map((a) => a.action).sort()).toEqual([
      ...Array<string>(made).fill('course.create'),
      'release.publish',
      'release.publish',
    ]);
    expect(added.every((a) => a.actorId === ana.id)).toBe(true);
    expect(bossErrors).toEqual([]);
  });
});
