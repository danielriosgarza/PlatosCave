import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { requestReplay } from '../../src/db/execution/runs';
import { auditEvents, testAttempts } from '../../src/db/schema';
import { RUN_QUEUE } from '../../src/execution/queues';
import { asClassScope, ids } from '../fixtures/world';
import {
  attemptUrl,
  call,
  config,
  DEV_IMAGE_ID,
  drain,
  type ExecWorld,
  execWorld,
  requestRun,
  rowOf,
  startAttempt,
} from './execution';

/**
 * A18 (§11; docs/design/runner.md §8.5, §8.7, §9): a runtime outage yields Run unavailable
 * without consuming an attempt; a failed grading run sends the attempt to NeedsReview; an
 * instructor replays it on the image the original run used.
 */

let w: ExecWorld;
let attempt: string;
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
};

beforeAll(async () => {
  w = await execWorld();
  attempt = await startAttempt(w, 'sam', ids.classA);
});
afterAll(async () => {
  await w?.close();
});

const attemptRow = async () => {
  const [row] = await w.testDb.db.select().from(testAttempts).where(eq(testAttempts.id, attempt));
  return row;
};
const CODE = 'def mean(xs):\n    return sum(xs) / len(xs)\n';

describe('A18 run unavailable', () => {
  test('A18 a dead-lettered run shows infrastructure_error, consumes no attempt, and Retry queues a new run', async () => {
    tick();
    const posted = await requestRun(w, 'sam', ids.classA, attempt, 'mean', CODE);
    expect(posted.status).toBe(202);
    await w.runner.failUntilDeadLetter({ kind: 'daemon_unreachable', message: 'docker: ENOENT' });
    expect(await drain(w)).toEqual({ results: 0, deadLetters: 1 });

    const read = await call(
      w,
      'sam',
      'GET',
      `${attemptUrl(ids.classA, attempt)}/runs/${posted.body.runId}`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ runId: posted.body.runId, state: 'infrastructure_error' });
    expect(read.body.result).toBeUndefined();
    expect(await rowOf(w, posted.body.runId)).toMatchObject({
      state: 'infrastructure_error',
      failure: { kind: 'daemon_unreachable', message: 'docker: ENOENT' },
      infrastructureAttempts: null,
    });

    // The attempt is untouched: still open, still the first of three.
    expect(await attemptRow()).toMatchObject({ state: 'in_progress', number: 1 });
    const overview = await call(
      w,
      'sam',
      'GET',
      `/api/classes/${ids.classA}/resources/${w.quizId}/test`,
    );
    expect(overview.body.eligibility).toMatchObject({ attemptsUsed: 1, attemptsAllowed: 3 });

    // Retry with the same code is a new run, never the failed one reused.
    tick();
    const retry = await requestRun(w, 'sam', ids.classA, attempt, 'mean', CODE);
    expect(retry.status).toBe(202);
    expect(retry.body.runId).not.toBe(posted.body.runId);
    expect(retry.body.reused).toBe(false);
    await call(
      w,
      'sam',
      'POST',
      `${attemptUrl(ids.classA, attempt)}/runs/${retry.body.runId}/cancel`,
    );
  });

  test('A18 a grading run that ends in a dead letter moves the attempt to NeedsReview', async () => {
    tick();
    const submitted = await call(w, 'sam', 'POST', `${attemptUrl(ids.classA, attempt)}/submit`, {
      submissionKey: 'a18-submit-1',
    });
    expect(submitted.status).toBe(200);
    expect((await attemptRow())?.state).toBe('submitted');
    // Grading jobs in question order: mean fails for good, median and spread finish.
    await w.runner.failUntilDeadLetter({ kind: 'image_unavailable', message: 'no such image' });
    await w.runner.finish(await w.runner.take());
    await w.runner.finish(await w.runner.take());
    expect(await drain(w)).toEqual({ results: 2, deadLetters: 1 });
    expect(await attemptRow()).toMatchObject({ state: 'needs_review', number: 1 });

    const results = await call(w, 'priya', 'GET', `${attemptUrl(ids.classA, attempt)}/results`);
    const grading = results.body.runs
      .filter((r: { reason: string }) => r.reason === 'grading')
      .sort((a: { questionId: string }, b: { questionId: string }) =>
        a.questionId.localeCompare(b.questionId),
      );
    expect(
      grading.map((r: { questionId: string; state: string }) => [r.questionId, r.state]),
    ).toEqual([
      ['mean', 'infrastructure_error'],
      ['median', 'passed'],
      ['spread', 'passed'],
    ]);
    expect(grading[0].failure).toEqual({ kind: 'image_unavailable', message: 'no such image' });
    // The student reaches none of it.
    const failed = grading[0].runId as string;
    expect(
      (await call(w, 'sam', 'GET', `${attemptUrl(ids.classA, attempt)}/runs/${failed}`)).status,
    ).toBe(404);
  });

  test('A18 an instructor replay runs against the dev image id the original result recorded', async () => {
    const base = attemptUrl(ids.classA, attempt);
    const results = await call(w, 'priya', 'GET', `${base}/results`);
    const original = results.body.runs.find(
      (r: { reason: string; questionId: string }) =>
        r.reason === 'grading' && r.questionId === 'median',
    );
    expect(original.result.imageId).toBe(DEV_IMAGE_ID);
    tick();
    const replay = await call(w, 'priya', 'POST', `${base}/questions/median/replays`, {
      reason: 'replay',
      note: 'audit',
    });
    expect(replay.status).toBe(202);
    const job = await w.runner.take();
    expect(job.data).toMatchObject({
      jobId: replay.body.runId,
      set: 'full',
      runtime: { id: 'python-3.12', image: DEV_IMAGE_ID },
    });
    const row = await rowOf(w, replay.body.runId);
    expect(row).toMatchObject({
      reason: 'replay',
      requestedBy: ids.priya,
      note: 'audit',
      graderVersion: original.graderVersion,
      codeHash: original.codeHash,
      imageRef: DEV_IMAGE_ID,
      priority: 0,
    });
    await w.runner.finish(job);
    const read = await call(w, 'priya', 'GET', `${base}/runs/${replay.body.runId}`);
    expect(read.body.state).toBe('passed');
    // The original records are untouched.
    expect((await rowOf(w, original.runId)).state).toBe('passed');
    const [audited] = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, replay.body.runId));
    expect(audited?.action).toBe('execution.replay_requested');
  });

  test('A18 a grading run that ended without a result is replayed on the image it was sent with', async () => {
    const base = attemptUrl(ids.classA, attempt);
    const before = await call(w, 'priya', 'GET', `${base}/results`);
    const failed = before.body.runs.find(
      (r: { reason: string; questionId: string }) =>
        r.reason === 'grading' && r.questionId === 'mean',
    );
    expect(failed).toMatchObject({ state: 'infrastructure_error', result: null });

    // Once the runtime's image is no longer the one the failed run was sent with, only a regrade
    // can run it: a replay would not be the identical grading.
    const scope = asClassScope(ids.classA, ids.statistics, ids.priya);
    const moved = config.RUNNER_RUNTIMES.map((r) => ({
      ...r,
      image: 'parallax-runner-python:next',
    }));
    expect(
      await requestReplay(
        w.testDb.db,
        () => ({ boss: w.boss, runtimes: moved }),
        scope,
        attempt,
        'mean',
        { reason: 'replay', note: '' },
        w.clock.now,
      ),
    ).toEqual({ ok: false, reason: 'no_result' });

    tick();
    const replay = await call(w, 'priya', 'POST', `${base}/questions/mean/replays`, {
      reason: 'replay',
    });
    expect(replay.status).toBe(202);
    const job = await w.runner.take();
    // The failed run was sent with the configured `:dev` reference, not a digest: unpinned.
    expect(job.data).toMatchObject({
      jobId: replay.body.runId,
      set: 'full',
      runtime: { id: 'python-3.12', language: 'python' },
    });
    expect(job.data.runtime.image).toBeUndefined();
    expect(await rowOf(w, replay.body.runId)).toMatchObject({
      reason: 'replay',
      graderVersion: failed.graderVersion,
      imageRef: failed.imageRef,
      codeHash: failed.codeHash,
    });
    await w.runner.finish(job);
    expect((await call(w, 'priya', 'GET', `${base}/runs/${replay.body.runId}`)).body.state).toBe(
      'passed',
    );
    expect((await rowOf(w, failed.runId)).state).toBe('infrastructure_error');
  });

  test('A18 a regrade needs a note and runs the current image', async () => {
    const base = attemptUrl(ids.classA, attempt);
    expect(
      (await call(w, 'priya', 'POST', `${base}/questions/mean/replays`, { reason: 'regrade' }))
        .status,
    ).toBe(400);
    tick();
    const regrade = await call(w, 'priya', 'POST', `${base}/questions/mean/replays`, {
      reason: 'regrade',
      note: 'image restored',
    });
    expect(regrade.status).toBe(202);
    const job = await w.runner.take();
    expect(job.data.jobId).toBe(regrade.body.runId);
    expect(job.data.runtime).toEqual({ id: 'python-3.12', language: 'python' });
    await w.runner.finish(job);
    // Students cannot ask for either.
    expect(
      (await call(w, 'sam', 'POST', `${base}/questions/mean/replays`, { reason: 'replay' })).status,
    ).toBe(403);
  });
  test('submission cancels the sample runs no slot has fetched and leaves an active one to finish', async () => {
    const bea = await startAttempt(w, 'bea', ids.classB);
    tick();
    const fetchedRun = await requestRun(w, 'bea', ids.classB, bea, 'mean', CODE);
    const unfetchedRun = await requestRun(w, 'bea', ids.classB, bea, 'median', CODE);
    expect(fetchedRun.status).toBe(202);
    expect(unfetchedRun.status).toBe(202);
    const fetched = await w.runner.take();
    expect(fetched.data.jobId).toBe(fetchedRun.body.runId);
    const unfetched = await rowOf(w, unfetchedRun.body.runId);
    expect((await w.boss.getJobById(RUN_QUEUE, unfetched.bossJobId))?.state).toBe('created');

    tick();
    const submitted = await call(w, 'bea', 'POST', `${attemptUrl(ids.classB, bea)}/submit`, {
      submissionKey: 'a18-submit-samples',
    });
    expect(submitted.status).toBe(200);

    // The run no slot fetched is cancelled with its job.
    expect(await rowOf(w, unfetchedRun.body.runId)).toMatchObject({ state: 'cancelled' });
    expect((await w.boss.getJobById(RUN_QUEUE, unfetched.bossJobId))?.state).toBe('cancelled');
    // The fetched one stays queued, its job active, and its result is recorded when it finishes.
    expect(await rowOf(w, fetchedRun.body.runId)).toMatchObject({ state: 'queued' });
    expect((await w.boss.getJobById(RUN_QUEUE, fetched.id))?.state).toBe('active');
    await w.runner.finish(fetched);
    expect((await drain(w)).results).toBeGreaterThanOrEqual(1);
    expect(await rowOf(w, fetchedRun.body.runId)).toMatchObject({ state: 'passed' });
  });
});
