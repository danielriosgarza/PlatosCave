import { eq } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { auditEvents, gradeReleases, grades } from '../../src/db/schema';
import gradesRelease, { GRADES_RELEASE } from '../../src/jobs/grades-release.job';
import { runScopedJob } from '../../src/jobs/scoped';
import { ids, type PersonName } from '../fixtures/world';
import {
  attemptUrl,
  call,
  drain,
  type ExecWorld,
  execWorld,
  start,
  startAttempt,
} from './execution';

/**
 * P4-AUD6: a test whose terms schedule the release of results releases them at that time
 * (§11 "Graded → Released: Instructor or scheduled release"), through the instructor's release
 * path (A17: actor, time and exact recipients recorded), and the student then finds the result
 * (A20). Class B: Marcus teaches Bea, Priya and Sam and schedules results for 12:00.
 */

const AT = new Date(start.getTime() + 3 * 60 * 60_000);
const CODE = 'def f(xs):\n    return 2\n';

/** Jobs the API sent; the test runs them as a worker would. */
const sent: { name: string; data: unknown; options: { startAfter?: Date } }[] = [];
const jobs = {
  createQueue: async () => {},
  send: async (name: string, data: unknown, options: { startAfter?: Date }) => {
    sent.push({ name, data, options });
    return `00000000-0000-4000-8000-00000000a0${String(sent.length).padStart(2, '0')}`;
  },
} as unknown as PgBoss;

let w: ExecWorld;
const attempt: Partial<Record<PersonName, string>> = {};
const at = (minutes: number) => {
  w.clock.now = new Date(start.getTime() + minutes * 60_000);
};

async function put(who: PersonName, url: string, payload: object) {
  const res = await w.app.inject({
    method: 'PUT',
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
    payload,
  });
  return res.statusCode;
}

/** Starts, answers and submits the test; `graded` runs its code checks to completion. */
async function takeTest(who: PersonName, graded = true) {
  const id = await startAttempt(w, who, ids.classB);
  attempt[who] = id;
  for (const questionId of ['mean', 'median', 'spread']) {
    expect(
      await put(who, `${attemptUrl(ids.classB, id)}/answers/${questionId}`, {
        value: { files: [{ path: 'solution.py', content: CODE }] },
        seq: 1,
      }),
    ).toBe(200);
  }
  await put(who, `${attemptUrl(ids.classB, id)}/answers/pick`, { value: ['b'], seq: 1 });
  const done = await call(w, who, 'POST', `${attemptUrl(ids.classB, id)}/submit`, {
    submissionKey: `aud6-submit-${who}`,
  });
  expect(done.status).toBe(200);
  if (graded) {
    for (let i = 0; i < 3; i++) await w.runner.finish(await w.runner.take());
    await drain(w);
  }
}

/** Marcus saves a draft grade; returns it as the grade history shows it. */
async function draft(who: PersonName) {
  const res = await call(
    w,
    'marcus',
    'POST',
    `${attemptUrl(ids.classB, attempt[who] as string)}/grade`,
    {
      expectedGradeId: null,
      manual: [],
      feedback: [{ target: { kind: 'attempt' }, text: `Feedback for ${who}` }],
    },
  );
  expect(res.status).toBe(200);
  return res.body.history[0] as { id: string; complete: boolean };
}

/** Runs a sent release job as the worker would, at the real time (after AT). */
function runReleaseJob(data: unknown) {
  const job = {
    id: '00000000-0000-4000-8000-0000000a0d06',
    name: GRADES_RELEASE,
    data,
    expireInSeconds: 60,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  } as unknown as Job<unknown>;
  return runScopedJob(w.testDb.db, gradesRelease, job);
}

const results = async (who: PersonName) =>
  (await call(w, who, 'GET', `/api/classes/${ids.classB}/resources/${w.quizId}/results`)).body
    .attempts[0];

const gradeIds: Partial<Record<PersonName, string>> = {};

beforeAll(async () => {
  w = await execWorld({ jobs });
  expect(
    await put('marcus', `/api/classes/${ids.classB}/resources/${w.quizId}/assignment`, {
      settings: {
        release: {
          results: 'scheduled',
          at: AT.toISOString(),
          solutions: 'never',
          hiddenTestDetails: false,
        },
      },
      expectedRevision: null,
    }),
  ).toBe(200);
  at(10);
  await takeTest('priya');
  at(20);
  await takeTest('sam');
  // Bea's grade is saved while her code checks still run, so it is incomplete.
  at(30);
  await takeTest('bea', false);
  at(60);
  gradeIds.priya = (await draft('priya')).id;
  const incomplete = await draft('bea');
  expect(incomplete.complete).toBe(false);
  gradeIds.bea = incomplete.id;
  // Sam's grade is first saved after the scheduled time.
  at(200);
  gradeIds.sam = (await draft('sam')).id;
});
afterAll(async () => {
  await w?.close();
});

describe('P4-AUD6 scheduled release of results', () => {
  test('A17 starting an attempt under a scheduled release queues the release job for that time', () => {
    const queued = sent.filter((s) => s.name === GRADES_RELEASE);
    expect(queued).toHaveLength(3);
    for (const job of queued) {
      expect(job.options.startAfter?.toISOString()).toBe(AT.toISOString());
      expect(job.data).toMatchObject({
        scope: { kind: 'class', classId: ids.classB },
        input: { resourceId: w.quizId },
      });
    }
  });

  test('A17 before the scheduled release a draft stays invisible to its student', async () => {
    expect(await results('priya')).toMatchObject({ status: 'pending', grade: null });
  });

  test('A17 at the scheduled time exactly the complete drafts saved by then are released, recorded with actor, time and recipients', async () => {
    const before = Date.now();
    const outcome = await runReleaseJob(sent[0]?.data);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toMatchObject({
      releasedBy: ids.marcus,
      released: 1,
    });
    expect((outcome.output as { skipped: unknown[] }).skipped).toEqual(
      expect.arrayContaining([
        { attemptId: attempt.bea, reason: 'incomplete' },
        { attemptId: attempt.sam, reason: 'saved_after_release_time' },
      ]),
    );
    const releases = await w.testDb.db
      .select()
      .from(gradeReleases)
      .where(eq(gradeReleases.classId, ids.classB));
    expect(releases).toHaveLength(1);
    const [release] = releases;
    expect(release?.releasedBy).toBe(ids.marcus);
    expect(release?.releasedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(release?.recipients).toEqual([
      { studentId: ids.priya, attemptId: attempt.priya, gradeId: gradeIds.priya },
    ]);
    const states = await w.testDb.db
      .select({ id: grades.id, state: grades.state })
      .from(grades)
      .where(eq(grades.classId, ids.classB));
    expect(new Map(states.map((g) => [g.id, g.state]))).toEqual(
      new Map([
        [gradeIds.priya, 'released'],
        [gradeIds.bea, 'draft'],
        [gradeIds.sam, 'draft'],
      ]),
    );
    const [event] = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, release?.id as string));
    expect(event).toMatchObject({ actorId: ids.marcus, action: 'grade.released' });
  });

  test('A17 a repeated or duplicate run of the release releases nothing more', async () => {
    for (const job of sent.filter((s) => s.name === GRADES_RELEASE)) {
      const outcome = await runReleaseJob(job.data);
      expect(outcome).toMatchObject({ status: 'completed', output: { released: 0 } });
    }
    const releases = await w.testDb.db
      .select()
      .from(gradeReleases)
      .where(eq(gradeReleases.classId, ids.classB));
    expect(releases).toHaveLength(1);
  });

  test('A20 the student finds the result released on schedule; a grade saved after it stays pending', async () => {
    expect(await results('priya')).toMatchObject({
      status: 'released',
      grade: {
        gradeId: gradeIds.priya,
        feedback: [{ target: { kind: 'attempt' }, text: 'Feedback for priya' }],
      },
    });
    const detail = await call(
      w,
      'priya',
      'GET',
      `${attemptUrl(ids.classB, attempt.priya as string)}/released`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.gradeId).toBe(gradeIds.priya);
    expect(await results('sam')).toMatchObject({ status: 'pending', grade: null });
    expect(
      (await call(w, 'sam', 'GET', `${attemptUrl(ids.classB, attempt.sam as string)}/released`))
        .status,
    ).toBe(404);
  });

  test('A17 an attempt started after the scheduled time queues no release job', async () => {
    const queued = sent.length;
    at(240);
    await startAttempt(w, 'priya', ids.classB);
    expect(sent.length).toBe(queued);
  });
});
