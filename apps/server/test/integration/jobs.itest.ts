import { and, eq } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { type ClassScope, type CourseScope, resolveCourse } from '../../src/auth/scope';
import { classMemberships, resourceRevisions, resources, topics } from '../../src/db/schema';
import { createBoss } from '../../src/jobs/boss';
import { listResourceJobStatus, setDerivedStatus } from '../../src/jobs/derived';
import {
  defineScopedJob,
  runScopedJob,
  type ScopedPayload,
  sendScopedJob,
  workScopedJob,
} from '../../src/jobs/scoped';
import { buildWorld, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

let testDb: TestDatabase;
let boss: PgBoss;
const runs: { classId: string; role: string; actor: string; note: string }[] = [];
const warnings: object[] = [];
const bossErrors: Error[] = [];

/** The no-op scoped job: records the scope it was handed and does nothing else. */
const noop = defineScopedJob({
  name: 'test.noop',
  scope: { kind: 'class', role: 'instructor' },
  input: z.object({ note: z.string() }),
  queue: { retryLimit: 2 },
  run: async ({ scope, input }) => {
    runs.push({ classId: scope.classId, role: scope.role, actor: scope.user.id, note: input.note });
    return { seen: scope.classId };
  },
});

const sensitive = defineScopedJob({
  name: 'test.sensitive',
  scope: { kind: 'course', role: 'owner' },
  input: z.object({}),
  run: async ({ scope }) => {
    scope.requireRecentAuth();
    return {};
  },
});

const fakeJob = (data: unknown): Job<unknown> => ({
  id: '00000000-0000-4000-8000-00000000f00d',
  name: 'test.noop',
  data,
  expireInSeconds: 60,
  heartbeatSeconds: null,
  retryCount: 0,
  signal: new AbortController().signal,
});

const payload = (actorId: string, classId: string, note = 'x'): ScopedPayload => ({
  actorId,
  scope: { kind: 'class', classId },
  input: { note },
});

/** A real resolved scope, as a route handler would hold it when it enqueues. */
async function classScope(actorId: string, classId: string): Promise<ClassScope> {
  const outcome = await runScopedJob(
    testDb.db,
    { ...noop, run: async ({ scope }) => ({ scope }) },
    fakeJob(payload(actorId, classId)),
  );
  if (outcome.status !== 'completed') throw new Error('fixture scope did not resolve');
  return (outcome.output as { scope: ClassScope }).scope;
}

async function courseScope(actorId: string, courseId: string): Promise<CourseScope> {
  const user = { id: actorId, kind: 'user' as const, name: '', email: null, ownerUserId: null };
  const resolution = await resolveCourse(
    testDb.db,
    { user, requireRecentAuth: () => {} },
    { kind: 'course', role: 'editor' },
    courseId,
  );
  if (!resolution.ok) throw new Error(resolution.reason);
  return resolution.scope as CourseScope;
}

/** Polls pg-boss until the job settles; the worker polls every half second. */
async function settled(name: string, id: string) {
  for (let i = 0; i < 40; i++) {
    const job = await boss.getJobById<ScopedPayload>(name, id);
    if (job && (job.state === 'completed' || job.state === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} did not settle`);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await buildWorld(testDb.db);
  boss = createBoss(testDb.db.$client, {
    role: 'worker',
    onError: (err) => bossErrors.push(err),
  });
  await boss.start();
  const log = { warn: (obj: object) => warnings.push(obj) };
  await workScopedJob(boss, testDb.db, noop, log, { pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.drop();
});

describe('runScopedJob', () => {
  test('refuses payloads without an actor or a scope', async () => {
    const cases: unknown[] = [
      null,
      { input: { note: 'x' } },
      { actorId: ids.marcus, input: { note: 'x' } },
      { scope: { kind: 'class', classId: ids.classB }, input: { note: 'x' } },
      { actorId: 'marcus', scope: { kind: 'class', classId: ids.classB }, input: {} },
    ];
    for (const data of cases) {
      const outcome = await runScopedJob(testDb.db, noop, fakeJob(data));
      expect(outcome).toEqual({
        status: 'refused',
        reason: 'payload has no valid actorId and scope',
      });
    }
    expect(runs).toEqual([]);
  });

  test('re-resolves membership: a member with the role runs with a branded class scope', async () => {
    const outcome = await runScopedJob(testDb.db, noop, fakeJob(payload(ids.marcus, ids.classB)));
    expect(outcome).toEqual({ status: 'completed', output: { seen: ids.classB } });
    expect(runs.at(-1)).toEqual({
      classId: ids.classB,
      role: 'instructor',
      actor: ids.marcus,
      note: 'x',
    });
  });

  test('refuses foreign classes, wrong roles, preview principals, unknown actors and bad input', async () => {
    const before = runs.length;
    const refused = async (data: unknown) => {
      const outcome = await runScopedJob(testDb.db, noop, fakeJob(data));
      expect(outcome.status).toBe('refused');
      return outcome.status === 'refused' ? outcome.reason : '';
    };
    // Marcus teaches B only; Priya teaches A but only studies in B.
    expect(await refused(payload(ids.marcus, ids.classA))).toBe('not a member of this class');
    expect(await refused(payload(ids.priya, ids.classB))).toBe('needs class role instructor');
    expect(await refused(payload(ids.bea, ids.classB))).toBe('needs class role instructor');
    expect(await refused(payload(ids.previewB, ids.classB))).toBe('needs class role instructor');
    expect(await refused(payload(ids.elena, ids.classB))).toBe('not a member of this class');
    expect(await refused(payload('00000000-0000-4000-8000-000000009999', ids.classB))).toBe(
      'actor does not exist',
    );
    expect(
      await refused({
        actorId: ids.marcus,
        scope: { kind: 'course', courseId: ids.statistics },
        input: { note: 'x' },
      }),
    ).toBe('job needs class scope');
    expect(await refused({ ...payload(ids.marcus, ids.classB), input: { note: 1 } })).toBe(
      'input does not match the job',
    );
    expect(runs.length).toBe(before);
  });

  test('a job never counts as a recent sign-in', async () => {
    const data = { actorId: ids.elena, scope: { kind: 'course', courseId: ids.statistics } };
    await expect(
      runScopedJob(
        testDb.db,
        { ...sensitive, input: z.object({}) },
        fakeJob({ ...data, input: {} }),
      ),
    ).rejects.toMatchObject({
      code: 'recent_auth_required',
    });
  });
});

describe('worker', () => {
  test('runs a no-op scoped job sent from a resolved scope', async () => {
    const scope = await classScope(ids.marcus, ids.classB);
    const id = await sendScopedJob(boss, noop, scope, { note: 'queued' });
    const job = await settled(noop.name, id);
    expect(job.state).toBe('completed');
    expect(job.data).toEqual(payload(ids.marcus, ids.classB, 'queued'));
    expect(job.output).toEqual({ seen: ids.classB });
    expect(runs.at(-1)?.note).toBe('queued');
  });

  test('a membership revoked after enqueue ends the job refused, without retries', async () => {
    const scope = await classScope(ids.marcus, ids.classB);
    const before = runs.length;
    await boss.offWork(noop.name);
    const id = await sendScopedJob(boss, noop, scope, { note: 'revoked' });
    await testDb.db
      .delete(classMemberships)
      .where(
        and(eq(classMemberships.classId, ids.classB), eq(classMemberships.userId, ids.marcus)),
      );
    await workScopedJob(
      boss,
      testDb.db,
      noop,
      { warn: (o) => warnings.push(o) },
      {
        pollingIntervalSeconds: 0.5,
      },
    );
    const job = await settled(noop.name, id);
    expect(job.state).toBe('failed');
    expect(job.retryCount).toBe(0);
    expect(job.output).toEqual({ refused: 'not a member of this class' });
    expect(runs.length).toBe(before);
    expect(warnings.at(-1)).toMatchObject({ jobId: id, reason: 'not a member of this class' });
    expect(bossErrors).toEqual([]);
  });
});

describe('derived status of resource revisions', () => {
  test('the job status view lists each resource head revision with its derived.status', async () => {
    const { db } = testDb;
    const [topic] = await db
      .insert(topics)
      .values({ courseId: ids.statistics, position: 0, title: 'Sampling', createdBy: ids.elena })
      .returning();
    if (!topic) throw new Error('no topic');
    const insertResource = async (title: string, position: number) => {
      const [row] = await db
        .insert(resources)
        .values({
          courseId: ids.statistics,
          topicId: topic.id,
          type: 'reading_native',
          title,
          position,
          createdBy: ids.elena,
        })
        .returning();
      if (!row) throw new Error('no resource');
      return row;
    };
    const reading = await insertResource('Reading', 0);
    const empty = await insertResource('Empty', 1);
    const [revision] = await db
      .insert(resourceRevisions)
      .values({
        resourceId: reading.id,
        courseId: ids.statistics,
        type: 'reading_native',
        content: { source: '# Sampling' },
        derived: { html: '<h1>Sampling</h1>' },
        contentHash: 'h1',
        createdBy: ids.elena,
      })
      .returning();
    if (!revision) throw new Error('no revision');
    await db
      .update(resources)
      .set({ headRevisionId: revision.id })
      .where(eq(resources.id, reading.id));

    const elena = await courseScope(ids.elena, ids.statistics);
    const status = {
      state: 'failed' as const,
      job: 'reading.ingest',
      jobId: 'j1',
      error: 'Unsupported file',
      updatedAt: '2026-10-01T09:00:00.000Z',
    };
    expect(await setDerivedStatus(db, elena, revision.id, status)).toBe(true);

    // Another course's scope cannot touch this revision.
    const olivia = await courseScope(ids.olivia, ids.linearModels);
    expect(await setDerivedStatus(db, olivia, revision.id, { ...status, state: 'ready' })).toBe(
      false,
    );
    expect(await listResourceJobStatus(db, olivia)).toEqual([]);

    expect(await listResourceJobStatus(db, elena)).toEqual([
      {
        resourceId: reading.id,
        topicId: topic.id,
        title: 'Reading',
        type: 'reading_native',
        revisionId: revision.id,
        status,
      },
      {
        resourceId: empty.id,
        topicId: topic.id,
        title: 'Empty',
        type: 'reading_native',
        revisionId: null,
        status: null,
      },
    ]);
    // Other derived outputs survive the status write.
    const [stored] = await db
      .select({ derived: resourceRevisions.derived })
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, revision.id));
    expect(stored?.derived).toEqual({ html: '<h1>Sampling</h1>', status });
  });
});
