import { testV1 } from '@parallax/contracts';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { graderVersionOf } from '../../src/assessments/terms';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource, getResource, updateResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import {
  assignmentOverrides,
  attemptAnswers,
  auditEvents,
  classes,
  testAttempts,
  testSubmissions,
} from '../../src/db/schema';
import { runScopedJob } from '../../src/jobs/scoped';
import testsExpire from '../../src/jobs/tests-expire.job';
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
 * Assigned tests (§11, §13): A14 one immutable submission per attempt whatever the client
 * repeats; A15 a timed attempt submitted by the server at its deadline from the last
 * acknowledged answers, unsent local work kept apart and never called submitted; A16 a started
 * attempt keeps its revision, grader and rubric across a new release; A21 submissions stay in
 * their cohort.
 */

const start = new Date('2026-10-01T09:00:00Z');
let clock = start;
const minutes = (n: number) => new Date(start.getTime() + n * 60_000);
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_HOST: '127.0.0.1',
  CONTENT_HOST: 'localhost',
  CONTENT_ORIGIN: 'http://localhost:3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
});

const quizV1 = {
  settings: { attempts: 2, durationMinutes: 30, timeZone: 'Europe/Amsterdam' },
  questions: [
    {
      id: 'spread',
      kind: 'choice',
      prompt: 'Which sample mean varies least?',
      points: 2,
      options: [
        { id: 'n10', label: 'n = 10' },
        { id: 'n100', label: 'n = 100' },
      ],
      correct: ['n100'],
    },
    {
      id: 'se',
      kind: 'numeric',
      prompt: 'Standard error of the mean?',
      points: 1,
      answer: 0.5,
      tolerance: 0.01,
    },
    {
      id: 'why',
      kind: 'explanation',
      prompt: 'Why does the larger sample vary less?',
      points: 3,
      rubric: [{ id: 'averaging', label: 'Names averaging out of noise', points: 3 }],
    },
    {
      id: 'mean',
      kind: 'code',
      prompt: 'Write mean(xs).',
      points: 4,
      runtime: 'python-3.12',
      files: [
        {
          path: 'solution.py',
          content: 'def mean(xs):\n    pass\n',
          editable: true,
          hidden: false,
        },
        { path: 'large.txt', content: '40 44', editable: false, hidden: true },
      ],
      checks: [
        {
          name: 'sample',
          kind: 'call',
          visibility: 'public',
          file: 'solution.py',
          function: 'mean',
          args: [[1, 2, 3]],
          expected: { value: 2 },
          compare: { mode: 'numeric' },
        },
        {
          name: 'hidden-large',
          kind: 'call',
          visibility: 'hidden',
          file: 'solution.py',
          files: ['large.txt'],
          function: 'mean',
          args: [[40, 44]],
          expected: { value: 42 },
          compare: { mode: 'numeric' },
          points: 3,
        },
      ],
    },
  ],
};

/** The change an instructor makes after students started: a new key, a dropped question. */
const quizV2 = {
  ...quizV1,
  questions: quizV1.questions
    .filter((q) => q.id !== 'why')
    .map((q) => (q.id === 'se' ? { ...q, prompt: 'Standard error (n = 4)?', answer: 0.25 } : q)),
};

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let quizId: string;
let v1: string;

const course = () => asCourseScope(ids.statistics, ids.elena);

async function adoptLatest(classId: string, instructor: string, from: string) {
  const published = await publishRelease(testDb.db, course(), { runtimes: DEV_RUNNER_RUNTIMES });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(
    testDb.db,
    asClassScope(classId, ids.statistics, instructor, { releaseId: from }),
    { releaseId: published.release.id, expectedReleaseId: from },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
  return { releaseId: published.release.id, diff: adopted.diff };
}

let releaseA = ids.releaseV1;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  const created = await createResource(
    testDb.db,
    course(),
    ids.sampling,
    { type: 'test', title: 'Sampling check', content: quizV1 },
    start,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  quizId = created.value.id;
  v1 = created.value.headRevisionId ?? '';
  releaseA = (await adoptLatest(ids.classA, ids.priya, ids.releaseV1)).releaseId;
  const adoptedB = await adoptRelease(
    testDb.db,
    asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: ids.releaseV1 }),
    { releaseId: releaseA, expectedReleaseId: ids.releaseV1 },
  );
  if (!adoptedB.ok) throw new Error(adoptedB.reason);
  app = await buildApp(config, { db: testDb.db, now: () => clock });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function call(
  who: PersonName,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:3100', cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

const testUrl = (classId: string) => `/api/classes/${classId}/resources/${quizId}`;
const attemptUrl = (classId: string, attemptId: string) =>
  `/api/classes/${classId}/test-attempts/${attemptId}`;
const save = (who: PersonName, classId: string, attemptId: string, q: string, body: object) =>
  call(who, 'PUT', `${attemptUrl(classId, attemptId)}/answers/${q}`, body);
const submit = (who: PersonName, classId: string, attemptId: string, submissionKey: string) =>
  call(who, 'POST', `${attemptUrl(classId, attemptId)}/submit`, { submissionKey });

/** Runs the deadline job as the worker would, for the student who started the attempt. */
async function runDeadlineJob(actorId: string, classId: string, attemptId: string) {
  const job = {
    id: '00000000-0000-4000-8000-00000000d1ed',
    name: testsExpire.name,
    data: { actorId, scope: { kind: 'class', classId }, input: { attemptId } },
    expireInSeconds: 60,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  } as unknown as Job<unknown>;
  return runScopedJob(testDb.db, testsExpire, job);
}

const submissionsOf = (attemptId: string) =>
  testDb.db.select().from(testSubmissions).where(eq(testSubmissions.attemptId, attemptId));

let samFirst: string;
let beaAttempt: string;

describe('A14 submit is idempotent', () => {
  test('A14 double-clicking Submit and retrying after a dropped response produce one immutable submission and the same receipt', async () => {
    clock = start;
    const overview = await call('sam', 'GET', `${testUrl(ids.classA)}/test`);
    expect(overview.status).toBe(200);
    expect(overview.body.eligibility).toEqual({
      canStart: true,
      reason: null,
      attemptsUsed: 0,
      attemptsAllowed: 2,
    });
    expect(overview.body.terms).toMatchObject({
      attempts: 2,
      durationMinutes: 30,
      timeZone: 'Europe/Amsterdam',
      late: { policy: 'none' },
      release: { results: 'manual' },
      totalPoints: 10,
    });

    // Two clicks on Start make one attempt.
    const [first, again] = await Promise.all([
      call('sam', 'POST', `${testUrl(ids.classA)}/test-attempts`),
      call('sam', 'POST', `${testUrl(ids.classA)}/test-attempts`),
    ]);
    expect(first.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    samFirst = first.body.id;
    expect(first.body).toMatchObject({
      number: 1,
      state: 'in_progress',
      resourceRevisionId: v1,
      deadlineAt: minutes(30).toISOString(),
      receipt: null,
    });
    expect(JSON.stringify(first.body.questions)).not.toMatch(/hidden|large\.txt|correct|rubric/);

    clock = minutes(2);
    const saved = await save('sam', ids.classA, samFirst, 'spread', { value: ['n100'], seq: 1 });
    expect(saved).toEqual({
      status: 200,
      body: { questionId: 'spread', seq: 1, savedAt: minutes(2).toISOString() },
    });

    clock = minutes(3);
    const key = 'sam-submit-0001';
    const [a, b] = await Promise.all([
      submit('sam', ids.classA, samFirst, key),
      submit('sam', ids.classA, samFirst, key),
    ]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(a.body).toMatchObject({
      attemptId: samFirst,
      submittedAt: minutes(3).toISOString(),
      autoSubmitted: false,
      late: false,
      answers: [{ questionId: 'spread', seq: 1, savedAt: minutes(2).toISOString() }],
      unanswered: ['se', 'why', 'mean'],
    });

    // The response was dropped; the client retries later with the same key.
    clock = minutes(10);
    expect(await submit('sam', ids.classA, samFirst, key)).toEqual(a);
    // Another key (a second tab) gets the existing receipt, not a second submission.
    expect(await submit('sam', ids.classA, samFirst, 'sam-submit-0002')).toEqual({
      status: 409,
      body: { error: 'already_submitted', receipt: a.body },
    });
    expect(await save('sam', ids.classA, samFirst, 'se', { value: 0.5, seq: 1 })).toEqual({
      status: 409,
      body: { error: 'already_submitted', receipt: a.body },
    });

    const rows = await submissionsOf(samFirst);
    expect(rows).toHaveLength(1);
    await expect(
      testDb.db
        .update(testSubmissions)
        .set({ late: true })
        .where(eq(testSubmissions.attemptId, samFirst)),
    ).rejects.toThrow();
    await expect(
      testDb.db
        .update(attemptAnswers)
        .set({ seq: 9 })
        .where(eq(attemptAnswers.attemptId, samFirst)),
    ).rejects.toThrow();
    const audits = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'test.submitted'),
          eq(auditEvents.targetId, a.body.submissionId),
        ),
      );
    expect(audits).toHaveLength(1);
    // The submitted test now counts for the topic's completion rule (P2-16).
    const reviews = await call(
      'sam',
      'GET',
      `/api/classes/${ids.classA}/topics/${ids.sampling}/reviews`,
    );
    expect(reviews.body.items).toContainEqual(
      expect.objectContaining({ resourceId: quizId, graded: true, submitted: true }),
    );
  });
});

describe('A15 deadline submission', () => {
  test('A15 a timed attempt expires offline: the receipt names the last server-saved answers and unsent work is kept, never submitted', async () => {
    clock = start;
    const started = await call('bea', 'POST', `${testUrl(ids.classB)}/test-attempts`);
    expect(started.status).toBe(200);
    beaAttempt = started.body.id;
    expect(started.body.deadlineAt).toBe(minutes(30).toISOString());

    clock = minutes(5);
    expect(
      (await save('bea', ids.classB, beaAttempt, 'spread', { value: ['n10'], seq: 1 })).status,
    ).toBe(200);
    clock = minutes(6);
    expect(
      (await save('bea', ids.classB, beaAttempt, 'spread', { value: ['n100'], seq: 2 })).status,
    ).toBe(200);
    expect(
      (await save('bea', ids.classB, beaAttempt, 'se', { value: 0.5, flagged: true, seq: 1 }))
        .status,
    ).toBe(200);
    // A delayed older save arrives last: it is acknowledged with the newer answer's counter.
    clock = minutes(7);
    expect(await save('bea', ids.classB, beaAttempt, 'spread', { value: ['n10'], seq: 1 })).toEqual(
      {
        status: 200,
        body: { questionId: 'spread', seq: 2, savedAt: minutes(6).toISOString() },
      },
    );
    // The server, not the browser, refuses an answer the question cannot take.
    expect(
      (await save('bea', ids.classB, beaAttempt, 'se', { value: 'half', seq: 2 })).status,
    ).toBe(400);

    // Bea goes offline and keeps typing; the deadline passes and the job runs.
    clock = minutes(31);
    const job = await runDeadlineJob(ids.bea, ids.classB, beaAttempt);
    expect(job).toMatchObject({ status: 'completed', output: { state: 'submitted' } });
    const [frozen] = await submissionsOf(beaAttempt);
    expect(frozen).toMatchObject({
      autoSubmitted: true,
      submissionKey: null,
      submittedAt: minutes(30),
      answers: [
        { questionId: 'se', value: 0.5, flagged: true, seq: 1 },
        { questionId: 'spread', value: ['n100'], flagged: false, seq: 2 },
      ],
    });

    // Reconnect: the server's state comes first.
    const state = await call('bea', 'GET', attemptUrl(ids.classB, beaAttempt));
    expect(state.body).toMatchObject({
      state: 'submitted',
      submittedAt: minutes(30).toISOString(),
    });
    const receipt = state.body.receipt;
    expect(receipt).toMatchObject({
      autoSubmitted: true,
      answers: [
        { questionId: 'se', seq: 1, savedAt: minutes(6).toISOString() },
        { questionId: 'spread', seq: 2, savedAt: minutes(6).toISOString() },
      ],
      unanswered: ['why', 'mean'],
    });
    // The unsent answer is refused with what was received, and never called submitted.
    const unsent = { value: 'Larger samples average out noise.', seq: 1 };
    expect(await save('bea', ids.classB, beaAttempt, 'why', unsent)).toEqual({
      status: 409,
      body: { error: 'attempt_closed', receipt },
    });
    expect(await submit('bea', ids.classB, beaAttempt, 'bea-submit-0001')).toEqual({
      status: 409,
      body: { error: 'attempt_closed', receipt },
    });
    const kept = await call('bea', 'POST', `${attemptUrl(ids.classB, beaAttempt)}/local-copy`, {
      answers: [{ questionId: 'why', value: unsent.value }],
    });
    expect(kept).toEqual({ status: 200, body: { localCopyAt: minutes(31).toISOString() } });
    const after = await call('bea', 'GET', attemptUrl(ids.classB, beaAttempt));
    expect(after.body.receipt).toEqual(receipt);
    expect(after.body.answers.map((a: { questionId: string }) => a.questionId)).toEqual([
      'se',
      'spread',
    ]);
    expect((await submissionsOf(beaAttempt))[0]?.answers).toEqual(frozen?.answers);

    // The instructor sees an auto-submission with a kept local copy, distinct from submitted work.
    const review = await call('marcus', 'GET', `${attemptUrl(ids.classB, beaAttempt)}/review`);
    expect(review.body).toMatchObject({
      state: 'submitted',
      receipt: { autoSubmitted: true },
      localCopy: [{ questionId: 'why', value: unsent.value }],
      localCopyAt: minutes(31).toISOString(),
    });
    expect(review.body.answers).toHaveLength(2);
  });

  test('A15 an attempt past its deadline is submitted on the next read even if the job never ran', async () => {
    clock = minutes(40);
    const started = await call('priya', 'POST', `${testUrl(ids.classB)}/test-attempts`);
    expect(started.body.deadlineAt).toBe(minutes(70).toISOString());
    clock = minutes(45);
    await save('priya', ids.classB, started.body.id, 'se', { value: 0.5, seq: 1 });
    clock = minutes(71);
    const overview = await call('priya', 'GET', `${testUrl(ids.classB)}/test`);
    expect(overview.body.attempts[0]).toMatchObject({
      id: started.body.id,
      state: 'submitted',
      submittedAt: minutes(70).toISOString(),
      receipt: { autoSubmitted: true, answers: [{ questionId: 'se', seq: 1 }] },
    });
    // The job arriving afterwards finds nothing left to do.
    const job = await runDeadlineJob(ids.priya, ids.classB, started.body.id);
    expect(job).toMatchObject({ status: 'completed', output: { state: 'submitted' } });
    expect(await submissionsOf(started.body.id)).toHaveLength(1);
  });

  test('an extension moves the deadline of the attempt in progress and is kept with its reason', async () => {
    clock = minutes(100);
    const started = await call('priya', 'POST', `${testUrl(ids.classB)}/test-attempts`);
    expect(started.body).toMatchObject({ number: 2, deadlineAt: minutes(130).toISOString() });
    const granted = await call('marcus', 'POST', `${testUrl(ids.classB)}/overrides`, {
      studentId: ids.priya,
      extraAttempts: 0,
      extraMinutes: 15,
      closesAt: null,
      reason: 'Assistive software restarted',
    });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ student: { id: ids.priya }, extraMinutes: 15 });
    const state = await call('priya', 'GET', attemptUrl(ids.classB, started.body.id));
    expect(state.body).toMatchObject({
      deadlineAt: minutes(145).toISOString(),
      terms: { durationMinutes: 45, override: { extraMinutes: 15 } },
    });
    clock = minutes(131);
    const job = await runDeadlineJob(ids.priya, ids.classB, started.body.id);
    // The job's own clock is the real one, long after this attempt's deadline either way.
    expect(job.status).toBe('completed');
    await expect(
      testDb.db.delete(assignmentOverrides).where(eq(assignmentOverrides.userId, ids.priya)),
    ).rejects.toThrow();
    // Only a student of this class can be granted an override.
    const outsider = await call('marcus', 'POST', `${testUrl(ids.classB)}/overrides`, {
      studentId: ids.sam,
      extraAttempts: 1,
      extraMinutes: 0,
      closesAt: null,
      reason: 'x',
    });
    expect(outsider.status).toBe(400);
  });
});

describe('A16 pinned revisions', () => {
  test('A16 an instructor changes a test after a student starts: the student finishes the original version, whose grader and rubric remain available', async () => {
    clock = minutes(200);
    const second = await call('sam', 'POST', `${testUrl(ids.classA)}/test-attempts`);
    expect(second.body).toMatchObject({ number: 2, state: 'in_progress', resourceRevisionId: v1 });
    const graderV1 = graderVersionOf(testV1.parse(quizV1));
    expect(second.body.graderVersion).toBe(graderV1);

    // The author changes the test; the class adopts the new release mid-attempt.
    const current = await getResource(testDb.db, course(), quizId);
    if (!current) throw new Error('no quiz');
    const edited = await updateResource(
      testDb.db,
      course(),
      quizId,
      { expectedRevision: current.revision, content: quizV2 },
      clock,
    );
    if (!edited.ok) throw new Error(JSON.stringify(edited));
    const v2 = edited.value.headRevisionId;
    const { diff } = await adoptLatest(ids.classA, ids.priya, releaseA);
    expect(diff.changed.find((c) => c.resourceId === quizId)).toMatchObject({
      fromRevisionId: v1,
      toRevisionId: v2,
      affected: { assignments: 2 },
    });

    // Sam finishes the version they started, including the question v2 dropped.
    clock = minutes(205);
    const resumed = await call('sam', 'GET', attemptUrl(ids.classA, second.body.id));
    expect(resumed.body.resourceRevisionId).toBe(v1);
    expect(resumed.body.questions.map((q: { id: string }) => q.id)).toEqual([
      'spread',
      'se',
      'why',
      'mean',
    ]);
    expect(resumed.body.questions[1].prompt).toBe('Standard error of the mean?');
    expect(
      (await save('sam', ids.classA, second.body.id, 'why', { value: 'Averaging.', seq: 1 }))
        .status,
    ).toBe(200);
    const receipt = await submit('sam', ids.classA, second.body.id, 'sam-submit-0003');
    expect(receipt.body).toMatchObject({ late: false, answers: [{ questionId: 'why' }] });

    // The instructor reads the original questions, grader version and rubric.
    const review = await call('priya', 'GET', `${attemptUrl(ids.classA, second.body.id)}/review`);
    expect(review.body).toMatchObject({ resourceRevisionId: v1, graderVersion: graderV1 });
    expect(review.body.test.questions[2].rubric).toEqual(quizV1.questions[2]?.rubric);
    expect(review.body.test.questions[1].answer).toBe(0.5);

    // Both attempts are used; an extra attempt with a reason allows a retake on the new version.
    const overview = await call('sam', 'GET', `${testUrl(ids.classA)}/test`);
    expect(overview.body).toMatchObject({
      resourceRevisionId: v2,
      eligibility: { canStart: false, reason: 'no_attempts_left', attemptsUsed: 2 },
    });
    expect((await call('sam', 'POST', `${testUrl(ids.classA)}/test-attempts`)).body).toEqual({
      error: 'not_eligible',
      reason: 'no_attempts_left',
    });
    const granted = await call('priya', 'POST', `${testUrl(ids.classA)}/overrides`, {
      studentId: ids.sam,
      extraAttempts: 1,
      extraMinutes: 0,
      closesAt: null,
      reason: 'Fire alarm during attempt 2',
    });
    expect(granted.status).toBe(201);
    const third = await call('sam', 'POST', `${testUrl(ids.classA)}/test-attempts`);
    expect(third.body).toMatchObject({ number: 3, resourceRevisionId: v2 });
    expect(third.body.graderVersion).not.toBe(graderV1);
    expect(third.body.terms.override).toEqual({
      extraAttempts: 1,
      extraMinutes: 0,
      closesAt: null,
    });

    // Earlier attempts are preserved with their own revisions.
    const attempts = await testDb.db
      .select({ number: testAttempts.number, revision: testAttempts.resourceRevisionId })
      .from(testAttempts)
      .where(and(eq(testAttempts.classId, ids.classA), eq(testAttempts.userId, ids.sam)));
    expect(attempts.sort((x, y) => x.number - y.number)).toEqual([
      { number: 1, revision: v1 },
      { number: 2, revision: v1 },
      { number: 3, revision: v2 },
    ]);
  });

  test('class terms are saved with a revision check and do not change started attempts', async () => {
    const url = `${testUrl(ids.classA)}/assignment`;
    const first = await call('priya', 'PUT', url, {
      settings: { durationMinutes: 60 },
      expectedRevision: null,
    });
    expect(first.body).toMatchObject({
      revision: 1,
      effective: { durationMinutes: 60, attempts: 2 },
    });
    const stale = await call('noor', 'PUT', url, {
      settings: { attempts: 5 },
      expectedRevision: null,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'revision_conflict', current: { revision: 1 } });
    const invalidTerms = await call('priya', 'PUT', url, {
      settings: { closesAt: '2026-10-01T08:00:00Z', opensAt: '2026-10-01T09:00:00Z' },
      expectedRevision: 1,
    });
    expect(invalidTerms.status).toBe(400);
    // Sam's attempt 3 keeps the 30 minutes it started with.
    const read = await call('priya', 'GET', url);
    expect(read.body.overrides).toEqual([
      expect.objectContaining({ student: { id: ids.sam, name: 'Sam Okafor' }, extraAttempts: 1 }),
    ]);
    const list = await call('priya', 'GET', `${testUrl(ids.classA)}/test-attempts`);
    const third = list.body.attempts.find((a: { number: number }) => a.number === 3);
    const view = await call('sam', 'GET', attemptUrl(ids.classA, third.id));
    expect(view.body.terms.durationMinutes).toBe(30);
  });
});

describe('A21 submissions per class', () => {
  test('A21 two cohorts of one course cannot see each other’s attempts, receipts or terms', async () => {
    // A student of class B cannot read a class A attempt by either class's path.
    expect((await call('bea', 'GET', attemptUrl(ids.classA, samFirst))).status).toBe(404);
    expect((await call('bea', 'GET', attemptUrl(ids.classB, samFirst))).status).toBe(404);
    expect(
      (
        await call('bea', 'POST', `${attemptUrl(ids.classB, samFirst)}/submit`, {
          submissionKey: 'bea-forged-01',
        })
      ).status,
    ).toBe(404);
    // Class B's instructor lists only class B's students and cannot open class A's attempts.
    const listB = await call('marcus', 'GET', `${testUrl(ids.classB)}/test-attempts`);
    const students = new Set(
      listB.body.attempts.map((a: { student: { id: string } }) => a.student.id),
    );
    expect([...students].sort()).toEqual([ids.priya, ids.bea].sort());
    expect((await call('marcus', 'GET', `${attemptUrl(ids.classB, samFirst)}/review`)).status).toBe(
      404,
    );
    expect((await call('marcus', 'GET', `${attemptUrl(ids.classA, samFirst)}/review`)).status).toBe(
      404,
    );
    // Priya teaches A and studies in B: her B attempts are absent from A, and B's list refuses her.
    const listA = await call('priya', 'GET', `${testUrl(ids.classA)}/test-attempts`);
    expect(
      listA.body.attempts.every((a: { student: { id: string } }) => a.student.id === ids.sam),
    ).toBe(true);
    expect((await call('priya', 'GET', `${testUrl(ids.classB)}/test-attempts`)).status).toBe(403);
    expect(
      (await call('priya', 'GET', `${attemptUrl(ids.classA, beaAttempt)}/review`)).status,
    ).toBe(404);
    // A student reads only their own attempt, never a classmate's, and never the instructor views.
    expect((await call('priya', 'GET', attemptUrl(ids.classB, beaAttempt))).status).toBe(404);
    expect((await call('sam', 'GET', `${testUrl(ids.classA)}/assignment`)).status).toBe(403);
    // Class A's terms do not leak into class B.
    const termsB = await call('bea', 'GET', `${testUrl(ids.classB)}/test`);
    expect(termsB.body.terms.durationMinutes).toBe(30);
    expect(termsB.body.terms.override).toBeNull();
  });

  test('an archived class keeps its attempts readable and starts or saves nothing', async () => {
    await testDb.db.update(classes).set({ archivedAt: clock }).where(eq(classes.id, ids.classB));
    try {
      expect((await call('bea', 'GET', attemptUrl(ids.classB, beaAttempt))).status).toBe(200);
      const overview = await call('bea', 'GET', `${testUrl(ids.classB)}/test`);
      expect(overview.body.eligibility).toMatchObject({
        canStart: false,
        reason: 'class_archived',
      });
      expect((await call('bea', 'POST', `${testUrl(ids.classB)}/test-attempts`)).body).toEqual({
        error: 'class_archived',
      });
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classB));
    }
  });
});
