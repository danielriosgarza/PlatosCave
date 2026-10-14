import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { auditEvents, gradeReleases, resources } from '../../src/db/schema';
import openRelease, { GRADES_OPEN_RELEASE } from '../../src/jobs/grades-open-release.job';
import { runScopedJob } from '../../src/jobs/scoped';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

// Open class (§13, N10; A50): a test scored automatically is released without an instructor, and
// a release with manually graded test parts is neither held when opening nor adopted. Class B:
// Marcus teaches Bea and Priya; Elena owns the course.

const now = new Date('2026-10-01T09:00:00Z');
let ticks = 0;
const clock = () => new Date(now.getTime() + ++ticks * 1000);

/** Jobs the API sent; the test runs them as a worker would. */
const sent: { name: string; data: unknown }[] = [];
const boss = {
  createQueue: async () => {},
  send: async (name: string, data: unknown) => {
    sent.push({ name, data });
    return `00000000-0000-4000-8000-0000000a50${String(sent.length).padStart(2, '0')}`;
  },
} as unknown as PgBoss;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  app = await buildApp(config, { db: testDb.db, now: clock, boss });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function call(who: PersonName, method: string, url: string, payload?: object) {
  const headers = { cookie: world.cookie[who] };
  const res = await app.inject({ method: method as 'GET', url, headers, payload });
  return { status: res.statusCode, body: res.json() };
}

const classB = `/api/classes/${ids.classB}`;
const setOpen = (open: boolean) => call('elena', 'PUT', `${classB}/open`, { open });
const publish = async () =>
  (await call('elena', 'POST', `/api/courses/${ids.statistics}/releases`)).body.release.id;
const adopt = (who: PersonName, classId: string, releaseId: string, expected: string) =>
  call(who, 'POST', `/api/classes/${classId}/adopt`, { releaseId, expectedReleaseId: expected });
const archiveQuiz = (archivedAt: Date | null) =>
  testDb.db.update(resources).set({ archivedAt }).where(eq(resources.id, ids.samplingQuiz));

/** A test with one choice question, scored from its answer key. */
const choice = { id: 'spread', kind: 'choice', prompt: 'Which mean varies least?', points: 2 };
const options = [
  { id: 'n10', label: 'n = 10' },
  { id: 'n100', label: 'n = 100' },
];
const question = { ...choice, options, correct: ['n100'] };
const checkTest = { schema: 'test.v1', settings: { attempts: 3 }, questions: [question] };

let checkId: string;
let v2: string;

/** Takes the check as `who` with the right answer; returns the attempt id. */
async function takeCheck(who: PersonName) {
  const started = await call(who, 'POST', `${classB}/resources/${checkId}/test-attempts`);
  expect(started.status).toBe(200);
  const attempt = `${classB}/test-attempts/${started.body.id}`;
  const answered = await call(who, 'PUT', `${attempt}/answers/spread`, { value: ['n100'], seq: 1 });
  expect(answered.status).toBe(200);
  const submitted = await call(who, 'POST', `${attempt}/submit`, {
    submissionKey: `a50-${started.body.id}`,
  });
  expect(submitted.status).toBe(200);
  return started.body.id as string;
}

const job = { id: '00000000-0000-4000-8000-0000000a50ff', name: GRADES_OPEN_RELEASE };
const jobFor = (data: unknown) =>
  runScopedJob(testDb.db, openRelease, { ...job, data } as unknown as Job<unknown>);
const openSends = () => sent.filter((s) => s.name === GRADES_OPEN_RELEASE);
const results = async (who: PersonName) =>
  (await call(who, 'GET', `${classB}/resources/${checkId}/results`)).body.attempts;
const releasesOfB = () =>
  testDb.db.select().from(gradeReleases).where(eq(gradeReleases.classId, ids.classB));

describe('automatic release in an open class (§13, N10)', () => {
  test('A50 a class is not opened while its release has manually graded test parts, and an open class does not adopt one', async () => {
    // Release v1's quiz has an explanation question, which an instructor marks by hand.
    const manualGrading = { status: 409, body: { error: 'manual_grading' } };
    expect(await setOpen(true)).toEqual(manualGrading);
    const topic = `/api/courses/${ids.statistics}/topics/${ids.sampling}`;
    const resource = { type: 'test', title: 'Sampling check', content: checkTest };
    const created = await call('elena', 'POST', `${topic}/resources`, resource);
    expect(created.status).toBe(200);
    checkId = created.body.id;
    await archiveQuiz(now);
    v2 = await publish();
    expect((await adopt('marcus', ids.classB, v2, ids.releaseV1)).status).toBe(200);
    expect(await setOpen(true)).toMatchObject({ status: 200, body: { open: true } });

    // The quiz is back in the next release, which the open class refuses.
    await archiveQuiz(null);
    const v3 = await publish();
    expect(await adopt('marcus', ids.classB, v3, v2)).toEqual(manualGrading);
    expect((await call('bea', 'GET', classB)).body).toMatchObject({ releaseId: v2, open: true });
    // A class that is not open adopts it as before.
    expect((await adopt('priya', ids.classA, v3, ids.releaseV1)).status).toBe(200);
  });

  test('A50 in an open class a test scored automatically is released without an instructor', async () => {
    const attemptId = await takeCheck('bea');
    // The submission queued the release as Bea; she cannot release, so the class's stand-in does.
    const scope = { kind: 'class', classId: ids.classB };
    const queued = { actorId: ids.bea, scope, input: { attemptId, round: 0 } };
    expect(openSends().map((s) => s.data)).toEqual([queued]);
    expect(await results('bea')).toEqual([expect.objectContaining({ status: 'pending' })]);
    const outcome = await jobFor(openSends()[0]?.data);
    expect(outcome).toMatchObject({ status: 'completed', output: { released: 1, pending: false } });

    const [release] = await releasesOfB();
    expect(release).toMatchObject({ releasedBy: ids.marcus, recipients: [{ attemptId }] });
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, release?.id as string));
    expect(event).toMatchObject({ action: 'grade.released', after: { open: true } });
    const [result] = await results('bea');
    expect(result).toMatchObject({ status: 'released', grade: { points: 2, possible: 2 } });

    // A repeated run releases nothing more.
    expect(await jobFor(openSends()[0]?.data)).toMatchObject({ output: { released: 0 } });
    expect(await releasesOfB()).toHaveLength(1);
  });

  test('A50 a grade an earlier run saved but did not release is released by the next run, once', async () => {
    // What a run stopped between saving the grade and releasing it leaves: a complete draft.
    const attemptId = await takeCheck('bea');
    const draft = { expectedGradeId: null, manual: [], feedback: [] };
    const grade = `${classB}/test-attempts/${attemptId}/grade`;
    const graded = await call('marcus', 'POST', grade, draft);
    expect(graded.body.history[0]).toMatchObject({ state: 'draft', complete: true });
    const data = openSends()[1]?.data;
    expect(await jobFor(data)).toMatchObject({ output: { released: 1 } });
    expect(await jobFor(data)).toMatchObject({ output: { released: 0 } });
    expect(await releasesOfB()).toHaveLength(2);
  });

  test('A50 a class that is not open waits for its instructor, as before', async () => {
    expect(await setOpen(false)).toMatchObject({ status: 200, body: { open: false } });
    const attemptId = await takeCheck('priya');
    expect(openSends()).toHaveLength(2);
    // A release queued while the class was open does nothing once it is closed.
    const data = { actorId: ids.priya, scope: { kind: 'class', classId: ids.classB } };
    expect(await jobFor({ ...data, input: { attemptId } })).toMatchObject({
      output: { released: 0 },
    });
    expect(await results('priya')).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(await releasesOfB()).toHaveLength(2);
  });
});
