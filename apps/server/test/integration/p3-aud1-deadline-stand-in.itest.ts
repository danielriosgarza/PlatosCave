import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEV_RUNNER_RUNTIMES } from '../../src/config';
import { removeMember } from '../../src/db/members';
import {
  classMemberships,
  executionJobs,
  testAttempts,
  testSubmissions,
} from '../../src/db/schema';
import { runScopedJob } from '../../src/jobs/scoped';
import testsExpire from '../../src/jobs/tests-expire.job';
import { asManagerScope, ids, type PersonName } from '../fixtures/world';
import { attemptUrl, drain, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * P3-AUD1: the deadline job (`tests.expire-attempt`) is the class's, not its actor's. When the
 * student who started a timed attempt, or the instructor whose extension re-queued its job, has
 * been removed by the deadline, the class's stand-in instructor runs it: the attempt is
 * submitted from its last saved answers (A14, A15), one grading run per code question is queued
 * on that exact code (A12), and a runner outage on such a run still moves it to NeedsReview (A18).
 * Class A: Priya and then Noor teach Sam; class B: Marcus teaches Bea, Priya and Sam.
 */

let w: ExecWorld;
const CODE = 'def f(xs):\n    return sum(xs) / len(xs)\n';
const manager = (classId: string) => asManagerScope(classId, ids.statistics, ids.elena);
const exec = () => ({ boss: w.boss, runtimes: DEV_RUNNER_RUNTIMES });

async function put(who: PersonName, url: string, payload: object) {
  const res = await w.app.inject({
    method: 'PUT',
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
    payload,
  });
  return res.statusCode;
}

/** Starts a timed attempt (deadline `minutes` from now) with code saved for every question. */
async function timedAttempt(who: PersonName, classId: string, minutes: number) {
  const id = await startAttempt(w, who, classId);
  for (const questionId of ['mean', 'median', 'spread']) {
    expect(
      await put(who, `${attemptUrl(classId, id)}/answers/${questionId}`, {
        value: { files: [{ path: 'solution.py', content: CODE }] },
        seq: 1,
      }),
    ).toBe(200);
  }
  // The quiz is untimed; a duration would set this same column when the attempt starts.
  await w.testDb.db
    .update(testAttempts)
    .set({ deadlineAt: new Date(w.clock.now.getTime() + minutes * 60_000) })
    .where(eq(testAttempts.id, id));
  return id;
}

/** Runs the deadline job as the worker would, for the actor who queued it. */
function runDeadlineJob(actorId: string, classId: string, attemptId: string) {
  const job = {
    id: '00000000-0000-4000-8000-00000000d1ed',
    name: testsExpire.name,
    data: { actorId, scope: { kind: 'class', classId }, input: { attemptId } },
    expireInSeconds: 60,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  } as unknown as Job<unknown>;
  return runScopedJob(w.testDb.db, testsExpire, job, { exec: exec() });
}

const attemptOf = async (id: string) =>
  (await w.testDb.db.select().from(testAttempts).where(eq(testAttempts.id, id)))[0];
const gradingOf = (attemptId: string) =>
  w.testDb.db
    .select()
    .from(executionJobs)
    .where(and(eq(executionJobs.attemptId, attemptId), eq(executionJobs.reason, 'grading')));
const submissionsOf = (attemptId: string) =>
  w.testDb.db.select().from(testSubmissions).where(eq(testSubmissions.attemptId, attemptId));
const later = (minutes: number) => {
  w.clock.now = new Date(w.clock.now.getTime() + minutes * 60_000);
};

beforeAll(async () => {
  w = await execWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('P3-AUD1 the deadline job outlives its actor’s membership', () => {
  let samAttempt: string;

  test('A15 a removed student’s timed attempt is submitted at its deadline by the stand-in instructor, from the last saved answers', async () => {
    samAttempt = await timedAttempt('sam', ids.classA, 30);
    expect((await removeMember(w.testDb.db, manager(ids.classA), ids.sam, w.clock.now)).ok).toBe(
      true,
    );
    later(31);

    const outcome = await runDeadlineJob(ids.sam, ids.classA, samAttempt);
    expect(outcome).toEqual({
      status: 'completed',
      output: { state: 'submitted', deadlineAt: null },
      standIn: 'not a member of this class',
    });
    const attempt = await attemptOf(samAttempt);
    expect(attempt?.state).toBe('submitted');
    const [submission] = await submissionsOf(samAttempt);
    expect(submission?.answers.map((a) => a.questionId).sort()).toEqual([
      'mean',
      'median',
      'spread',
    ]);
  });

  test('A12 the stand-in queues one grading run per code question on the student’s exact saved code', async () => {
    const runs = await gradingOf(samAttempt);
    expect(runs.map((r) => r.questionId).sort()).toEqual(['mean', 'median', 'spread']);
    for (const run of runs) {
      expect(run).toMatchObject({
        userId: ids.sam,
        classId: ids.classA,
        checkSet: 'full',
        snapshot: { files: [{ path: 'solution.py', content: CODE }] },
      });
      expect(run.jobSentAt).not.toBeNull();
    }
  });

  test('A14 running the deadline job again leaves one submission and the same grading runs', async () => {
    const before = (await gradingOf(samAttempt)).map((r) => r.id).sort();
    expect((await runDeadlineJob(ids.sam, ids.classA, samAttempt)).status).toBe('completed');
    expect(await submissionsOf(samAttempt)).toHaveLength(1);
    expect((await gradingOf(samAttempt)).map((r) => r.id).sort()).toEqual(before);
  });

  test('A18 a runner outage on a removed student’s grading run moves the attempt to NeedsReview', async () => {
    // Work the three grading runs: the first is lost to the runner, the others pass.
    await w.runner.failUntilDeadLetter({ kind: 'daemon_unreachable', message: 'docker down' });
    for (let i = 0; i < 2; i++) await w.runner.finish(await w.runner.take());
    expect(await drain(w, w.clock.now)).toEqual({ results: 2, deadLetters: 1 });
    const runs = await gradingOf(samAttempt);
    expect(runs.map((r) => r.state).sort()).toEqual(['infrastructure_error', 'passed', 'passed']);
    expect((await attemptOf(samAttempt))?.state).toBe('needs_review');
  });

  test('A15 the deadline job queued by an instructor who has since been removed still submits and grades the attempt', async () => {
    // Sam is back in class A; the extension's job was queued as Priya, who then leaves.
    await w.testDb.db
      .insert(classMemberships)
      .values({ classId: ids.classA, userId: ids.sam, role: 'student' });
    const attempt = await timedAttempt('sam', ids.classA, 20);
    expect((await removeMember(w.testDb.db, manager(ids.classA), ids.priya, w.clock.now)).ok).toBe(
      true,
    );
    later(21);

    const outcome = await runDeadlineJob(ids.priya, ids.classA, attempt);
    expect(outcome).toMatchObject({ status: 'completed', standIn: 'not a member of this class' });
    expect((await attemptOf(attempt))?.state).toBe('submitted');
    expect(await submissionsOf(attempt)).toHaveLength(1);
    expect((await gradingOf(attempt)).map((r) => r.questionId).sort()).toEqual([
      'mean',
      'median',
      'spread',
    ]);
  });

  test('A15 the actor’s own scope is used while it resolves: no stand-in for a member', async () => {
    const attempt = await timedAttempt('bea', ids.classB, 10);
    later(11);
    expect(await runDeadlineJob(ids.bea, ids.classB, attempt)).toEqual({
      status: 'completed',
      output: { state: 'submitted', deadlineAt: null },
    });
    expect((await gradingOf(attempt)).map((r) => r.questionId).sort()).toEqual([
      'mean',
      'median',
      'spread',
    ]);
  });

  test('A15 a class with no instructor left refuses the job with the actor’s reason and queues nothing', async () => {
    const attempt = await timedAttempt('sam', ids.classB, 10);
    for (const who of [ids.sam, ids.marcus]) {
      expect((await removeMember(w.testDb.db, manager(ids.classB), who, w.clock.now)).ok).toBe(
        true,
      );
    }
    later(11);
    expect(await runDeadlineJob(ids.sam, ids.classB, attempt)).toEqual({
      status: 'refused',
      reason: 'not a member of this class',
    });
    expect(await gradingOf(attempt)).toEqual([]);
  });
});
