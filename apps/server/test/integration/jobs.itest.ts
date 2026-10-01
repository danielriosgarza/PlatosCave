import { and, eq } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { type ClassScope, type CourseScope, resolveActorScope } from '../../src/auth/scope';
import type { Db } from '../../src/db/client';
import { validateDrafts } from '../../src/db/content/releases';
import { createBoss } from '../../src/db/jobs/boss';
import { listResourceJobStatus, setDerivedStatus } from '../../src/db/jobs/derived';
import { classMemberships, resourceRevisions, resources, topics } from '../../src/db/schema';
import {
  defineScopedJob,
  ensureQueues,
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
const errors: object[] = [];
const bossErrors: Error[] = [];
const log = { warn: (obj: object) => warnings.push(obj), error: (obj: object) => errors.push(obj) };

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

const recentAuthErrors: unknown[] = [];
const sensitive = defineScopedJob({
  name: 'test.sensitive',
  scope: { kind: 'course', role: 'owner' },
  input: z.object({}),
  queue: { retryLimit: 2 },
  run: async ({ scope }) => {
    try {
      scope.requireRecentAuth();
    } catch (err) {
      recentAuthErrors.push(err);
      throw err;
    }
    return {};
  },
});

/** Fails on `boom`, so one batch holds a failing and a succeeding job. */
const flakyRuns: string[] = [];
const flaky = defineScopedJob({
  name: 'test.flaky',
  scope: { kind: 'class', role: 'instructor' },
  input: z.object({ note: z.string() }),
  queue: { retryLimit: 1, retryDelay: 0 },
  run: async ({ input }) => {
    flakyRuns.push(input.note);
    if (input.note === 'boom') throw new Error('conversion crashed');
    return { done: input.note };
  },
});

/** Input with a transform and a Date: parsed once, when the job runs. */
const typed = defineScopedJob({
  name: 'test.typed',
  scope: { kind: 'class', role: 'instructor' },
  input: z.object({ words: z.string().transform((s) => s.split(' ')), at: z.coerce.date() }),
  run: async ({ input }) => ({ words: input.words, at: input.at.toISOString() }),
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
  const resolution = await resolveActorScope(
    testDb.db,
    actorId,
    () => {},
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
    onWarning: (warning) => warnings.push(warning),
  });
  await boss.start();
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

  test('a job never counts as a recent sign-in: requireRecentAuth() is a refusal', async () => {
    const data = { actorId: ids.elena, scope: { kind: 'course', courseId: ids.statistics } };
    const outcome = await runScopedJob(testDb.db, sensitive, fakeJob({ ...data, input: {} }));
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'a job cannot count as a recent sign-in',
    });
    expect(recentAuthErrors.at(-1)).toMatchObject({
      statusCode: 401,
      code: 'recent_auth_required',
    });
  });

  test('a payload of the wrong scope kind is refused before any query', async () => {
    const noDb = new Proxy({} as Db, {
      get: () => {
        throw new Error('the database was queried');
      },
    });
    const data = { actorId: ids.marcus, scope: { kind: 'course', courseId: ids.statistics } };
    expect(await runScopedJob(noDb, noop, fakeJob({ ...data, input: { note: 'x' } }))).toEqual({
      status: 'refused',
      reason: 'job needs class scope',
    });
  });

  test('resolveActorScope loads the actor itself and refuses unknown or malformed ids', async () => {
    const rule = { kind: 'class', role: 'instructor' } as const;
    const resolve = (actorId: string) =>
      resolveActorScope(testDb.db, actorId, () => {}, rule, ids.classB);
    expect(await resolve('00000000-0000-4000-8000-000000009999')).toMatchObject({
      ok: false,
      status: 404,
      reason: 'actor does not exist',
    });
    expect(await resolve('marcus')).toMatchObject({ ok: false, reason: 'actor does not exist' });
    const marcus = await resolve(ids.marcus);
    expect(marcus.ok && (marcus.scope as ClassScope).user).toMatchObject({
      id: ids.marcus,
      kind: 'user',
    });
  });
});

describe('worker', () => {
  test('runs a no-op scoped job sent from a resolved scope', async () => {
    const scope = await classScope(ids.marcus, ids.classB);
    const id = await sendScopedJob(boss, noop, scope, { note: 'queued' });
    if (!id) throw new Error('not sent');
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
    await workScopedJob(boss, testDb.db, noop, log, { pollingIntervalSeconds: 0.5 });
    if (!id) throw new Error('not sent');
    const job = await settled(noop.name, id);
    expect(job.state).toBe('failed');
    expect(job.retryCount).toBe(0);
    expect(job.output).toEqual({ refused: 'not a member of this class' });
    expect(runs.length).toBe(before);
    expect(warnings.at(-1)).toMatchObject({ jobId: id, reason: 'not a member of this class' });
    expect(bossErrors).toEqual([]);
  });

  test('a job calling requireRecentAuth() ends refused, without retries', async () => {
    const scope = await courseScope(ids.elena, ids.statistics);
    await workScopedJob(boss, testDb.db, sensitive, log, { pollingIntervalSeconds: 0.5 });
    const id = await sendScopedJob(boss, sensitive, scope, {});
    if (!id) throw new Error('not sent');
    const job = await settled(sensitive.name, id);
    expect(job.state).toBe('failed');
    expect(job.retryCount).toBe(0);
    expect(job.output).toEqual({ refused: 'a job cannot count as a recent sign-in' });
  });

  test('one job failing settles alone: the rest of its batch runs once, pg-boss retries it', async () => {
    // Priya teaches class A in the shared world (Marcus lost class B above).
    const scope = await classScope(ids.priya, ids.classA);
    await ensureQueues(boss, [flaky]);
    const boomId = await sendScopedJob(boss, flaky, scope, { note: 'boom' });
    const okId = await sendScopedJob(boss, flaky, scope, { note: 'ok' });
    if (!boomId || !okId) throw new Error('not sent');
    await workScopedJob(boss, testDb.db, flaky, log, {
      pollingIntervalSeconds: 0.5,
      batchSize: 2,
    });
    const ok = await settled(flaky.name, okId);
    const boom = await settled(flaky.name, boomId);
    expect(ok.state).toBe('completed');
    expect(ok.output).toEqual({ done: 'ok' });
    expect(boom.state).toBe('failed');
    expect(boom.retryCount).toBe(1);
    expect(boom.output).toEqual({ error: 'conversion crashed' });
    expect(flakyRuns.filter((n) => n === 'ok')).toEqual(['ok']);
    expect(flakyRuns.filter((n) => n === 'boom')).toEqual(['boom', 'boom']);
    expect(errors.at(-1)).toMatchObject({
      job: flaky.name,
      jobId: boomId,
      err: expect.objectContaining({ message: 'conversion crashed' }),
    });
  });

  test('sendScopedJob stores the input as given; it is parsed once when the job runs', async () => {
    const scope = await classScope(ids.priya, ids.classA);
    await workScopedJob(boss, testDb.db, typed, log, { pollingIntervalSeconds: 0.5 });
    const at = new Date('2026-10-01T09:30:00.000Z');
    const id = await sendScopedJob(boss, typed, scope, { words: 'one two', at });
    if (!id) throw new Error('not sent');
    const job = await settled(typed.name, id);
    expect(job.data.input).toEqual({ words: 'one two', at: at.toISOString() });
    expect(job.state).toBe('completed');
    expect(job.output).toEqual({ words: ['one', 'two'], at: at.toISOString() });
    // Invalid input is refused at send time.
    await expect(sendScopedJob(boss, typed, scope, { words: 1 as never, at })).rejects.toThrow();
  });

  test('a deduplicated send resolves to null', async () => {
    const scope = await classScope(ids.priya, ids.classA);
    await ensureQueues(boss, [typed]);
    const at = new Date();
    const options = { singletonKey: 'one-per-revision', singletonSeconds: 60, startAfter: 60 };
    expect(await sendScopedJob(boss, typed, scope, { words: 'a', at }, options)).toEqual(
      expect.any(String),
    );
    expect(await sendScopedJob(boss, typed, scope, { words: 'a', at }, options)).toBeNull();
  });

  test('pg-boss warnings reach the warning listener', () => {
    const warning = { message: 'queue backlog', data: { name: 'test.noop' } };
    boss.emit('warning', warning);
    expect(warnings.at(-1)).toEqual(warning);
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
    // The shared world has resources of its own; this test looks only at the topic it made.
    const inTopic = async (scope: CourseScope) =>
      (await listResourceJobStatus(db, scope)).filter((row) => row.topicId === topic.id);
    expect(await inTopic(olivia)).toEqual([]);

    expect(await inTopic(elena)).toEqual([
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

  test('archived topics and unreadable statuses: hidden, and shown as failed', async () => {
    const { db } = testDb;
    const elena = await courseScope(ids.elena, ids.statistics);
    const insertTopic = async (title: string, archived: boolean) => {
      const [row] = await db
        .insert(topics)
        .values({
          courseId: ids.statistics,
          position: 10,
          title,
          createdBy: ids.elena,
          archivedAt: archived ? new Date() : null,
        })
        .returning();
      if (!row) throw new Error('no topic');
      return row;
    };
    const live = await insertTopic('Live', false);
    const archived = await insertTopic('Archived', true);
    const withRevision = async (topicId: string, derived: Record<string, unknown>) => {
      const [resource] = await db
        .insert(resources)
        .values({
          courseId: ids.statistics,
          topicId,
          type: 'slides_pdf',
          title: 'Deck',
          position: 0,
          createdBy: ids.elena,
        })
        .returning();
      if (!resource) throw new Error('no resource');
      const [revision] = await db
        .insert(resourceRevisions)
        .values({
          resourceId: resource.id,
          courseId: ids.statistics,
          type: 'slides_pdf',
          content: {},
          derived,
          contentHash: `h-${resource.id}`,
          createdBy: ids.elena,
        })
        .returning();
      if (!revision) throw new Error('no revision');
      await db
        .update(resources)
        .set({ headRevisionId: revision.id })
        .where(eq(resources.id, resource.id));
      return { resource, revision };
    };
    const older = await withRevision(live.id, { status: 'ready' });
    await withRevision(archived.id, {});

    const rows = await listResourceJobStatus(db, elena);
    expect(rows.filter((r) => r.topicId === archived.id)).toEqual([]);
    expect(rows.filter((r) => r.topicId === live.id)).toEqual([
      expect.objectContaining({
        resourceId: older.resource.id,
        status: {
          state: 'failed',
          job: 'unknown',
          jobId: null,
          error: 'unreadable status',
          updatedAt: older.revision.createdAt.toISOString(),
        },
      }),
    ]);
  });

  test('a deck publishes once its conversion job marked the revision ready', async () => {
    const { db } = testDb;
    const elena = await courseScope(ids.elena, ids.statistics);
    const [topic] = await db
      .insert(topics)
      .values({ courseId: ids.statistics, position: 20, title: 'Decks', createdBy: ids.elena })
      .returning();
    if (!topic) throw new Error('no topic');
    const [deck] = await db
      .insert(resources)
      .values({
        courseId: ids.statistics,
        topicId: topic.id,
        type: 'slides_pdf',
        title: 'Deck',
        position: 0,
        createdBy: ids.elena,
      })
      .returning();
    if (!deck) throw new Error('no resource');
    const [revision] = await db
      .insert(resourceRevisions)
      .values({
        resourceId: deck.id,
        courseId: ids.statistics,
        type: 'slides_pdf',
        content: {},
        contentHash: 'deck',
        createdBy: ids.elena,
      })
      .returning();
    if (!revision) throw new Error('no revision');
    await db
      .update(resources)
      .set({ headRevisionId: revision.id })
      .where(eq(resources.id, deck.id));

    const unconverted = async () =>
      (await validateDrafts(db, elena)).errors.filter(
        (e) => e.code === 'unconverted_deck' && e.resourceId === deck.id,
      );
    const status = (state: 'running' | 'ready') => ({
      state,
      job: 'slides.convert',
      jobId: 'j2',
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(await unconverted()).toHaveLength(1);
    await setDerivedStatus(db, elena, revision.id, status('running'));
    expect(await unconverted()).toHaveLength(1);
    await setDerivedStatus(db, elena, revision.id, status('ready'));
    expect(await unconverted()).toEqual([]);
  });
});
