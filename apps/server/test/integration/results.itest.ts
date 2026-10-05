import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { onResultMessage, UnknownRunError } from '../../src/db/execution/results';
import { type ExecDeps, requestRun as requestRunService } from '../../src/db/execution/runs';
import { readState } from '../../src/db/execution/status';
import { executionResults, testAttempts } from '../../src/db/schema';
import { workExecution } from '../../src/execution/handlers';
import { RESULT_QUEUE, RUN_QUEUE } from '../../src/execution/queues';
import { asClassScope, ids } from '../fixtures/world';
import {
  attemptUrl,
  call,
  cloneRow,
  config,
  drain,
  type ExecWorld,
  execWorld,
  files,
  outcomeFor,
  requestRun,
  resultsOf,
  rowOf,
  startAttempt,
} from './execution';

/**
 * The result and failure handlers and the staleness rule (docs/design/runner.md §2 step 4, §8.5).
 * A fake runner drives jobs through pg-boss and pg-boss itself dead-letters them; nothing here
 * hand-builds a result message or a dead letter.
 */

let w: ExecWorld;
let attempt: string;
const tick = (ms = 1000) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms);
};
const samA = () => asClassScope(ids.classA, ids.statistics, ids.sam, { role: 'student' });
const queues = () => ({ boss: w.boss, run: RUN_QUEUE, result: RESULT_QUEUE });

beforeAll(async () => {
  w = await execWorld();
  attempt = await startAttempt(w, 'sam', ids.classA);
});
afterAll(async () => {
  await w?.close();
});

/** A queued sample run of Sam's attempt on `question`; earlier runs are settled first. */
async function newRun(question = 'mean', code = `# ${randomUUID()}\n`) {
  tick();
  const res = await requestRun(w, 'sam', ids.classA, attempt, question, code);
  if (res.status !== 202) throw new Error(`run: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.runId as string;
}
const read = (runId: string) =>
  call(w, 'sam', 'GET', `${attemptUrl(ids.classA, attempt)}/runs/${runId}`);
const cancel = (runId: string) =>
  call(w, 'sam', 'POST', `${attemptUrl(ids.classA, attempt)}/runs/${runId}/cancel`);

/** Run-service dependencies whose queue is `boss`, for wrapping its calls. */
const depsWith = (boss: PgBoss): ExecDeps => ({ boss, runtimes: config.RUNNER_RUNTIMES });

/** The server's queue with `send` replaced; everything else passes through. */
function wrapSend(
  around: (send: () => Promise<string | null>, jobId: string) => Promise<string | null>,
) {
  return new Proxy(w.boss, {
    get(target, prop, receiver) {
      if (prop === 'send') {
        return (name: string, data: { jobId: string }, options: object) =>
          around(() => target.send(name, data, options), data.jobId);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('result and dead-letter handlers (§8.5)', () => {
  test('a result for a row not yet committed is retried, not dropped', async () => {
    const source = await newRun();
    const ghost = randomUUID();
    const job = await w.runner.take();
    const outcome = { ...outcomeFor(job.data), jobId: ghost };
    await expect(
      onResultMessage(w.testDb.db, w.boss, RUN_QUEUE, outcome, new Date()),
    ).rejects.toBeInstanceOf(UnknownRunError);
    // The row commits later; the retried message then records.
    await cloneRow(w, source, { id: ghost, jobSentAt: w.clock.now });
    expect(await onResultMessage(w.testDb.db, w.boss, RUN_QUEUE, outcome, new Date())).toBe(
      'recorded',
    );
    expect((await rowOf(w, ghost)).state).toBe('passed');
    await w.runner.finish(job);
    await drain(w);
  });

  test('a duplicate result is ignored', async () => {
    const runId = await newRun();
    const job = await w.runner.take();
    const outcome = await w.runner.finish(job);
    expect(await drain(w)).toEqual({ results: 1, deadLetters: 0 });
    expect(await onResultMessage(w.testDb.db, w.boss, RUN_QUEUE, outcome, new Date())).toBe(
      'ignored',
    );
    expect(await resultsOf(w, runId)).toHaveLength(1);
    expect(await rowOf(w, runId)).toMatchObject({
      state: 'passed',
      infrastructureAttempts: 0,
      startedAt: expect.any(Date),
    });
  });

  test('a result for a row already terminal leaves it unchanged', async () => {
    const runId = await newRun();
    const job = await w.runner.take();
    // Settled meanwhile (a cancel that raced the fetch: the job runs out, its result is dropped).
    await w.testDb.db.execute(
      sql`UPDATE execution_jobs SET state = 'cancelled', finished_at = now() WHERE id = ${runId}`,
    );
    await w.runner.finish(job);
    expect(await drain(w)).toEqual({ results: 1, deadLetters: 0 });
    expect((await rowOf(w, runId)).state).toBe('cancelled');
    expect(await resultsOf(w, runId)).toHaveLength(0);
  });

  test('the worker handlers record results through the pg-boss work loop', async () => {
    const quiet = { info() {}, warn() {}, error() {} };
    await workExecution(w.boss, w.testDb.db, quiet as never);
    const runId = await newRun();
    await w.runner.finish(await w.runner.take());
    const deadline = Date.now() + 10_000;
    while ((await rowOf(w, runId)).state !== 'passed') {
      if (Date.now() > deadline) throw new Error('the worker never recorded the result');
      await new Promise((r) => setTimeout(r, 100));
    }
    await w.boss.offWork(RESULT_QUEUE);
    await w.boss.offWork('execution.failed');
  });
});

describe('staleness rule at read time (§8.5)', () => {
  test('a queued run reports its queue position; a fetched one reports running', async () => {
    const first = await newRun('mean');
    const second = await newRun('median');
    expect((await read(first)).body).toMatchObject({ state: 'queued', queuePosition: 0 });
    expect((await read(second)).body).toMatchObject({ state: 'queued', queuePosition: 1 });
    const job = await w.runner.take();
    expect((await read(first)).body).toMatchObject({
      state: 'running',
      startedAt: expect.any(String),
    });
    expect((await read(second)).body).toMatchObject({ state: 'queued', queuePosition: 0 });
    await w.runner.finish(job);
    await cancel(second);
    await drain(w);
  });

  test('a completed job whose result message is still queued is recorded from the job, and the message is then a duplicate', async () => {
    const runId = await newRun();
    const job = await w.runner.take();
    await w.runner.finish(job);
    const got = await read(runId);
    expect(got.body).toMatchObject({ state: 'passed', result: { status: 'passed' } });
    expect(await rowOf(w, runId)).toMatchObject({ infrastructureAttempts: 0 });
    expect(await drain(w)).toEqual({ results: 1, deadLetters: 0 });
    expect(await resultsOf(w, runId)).toHaveLength(1);
  });

  test('a completed job whose output is not an outcome settles result_invalid', async () => {
    const runId = await newRun();
    const job = await w.runner.take();
    await w.runner.boss.complete(RUN_QUEUE, job.id, { garbage: true });
    expect((await read(runId)).body.state).toBe('infrastructure_error');
    expect((await rowOf(w, runId)).failure).toMatchObject({ kind: 'result_invalid' });
  });

  test('a terminally failed job settles infrastructure_error with its kind before the dead letter is worked', async () => {
    const runId = await newRun();
    await w.runner.failUntilDeadLetter({ kind: 'harness_failed', message: 'exit 1' });
    expect((await read(runId)).body.state).toBe('infrastructure_error');
    expect((await rowOf(w, runId)).failure).toEqual({ kind: 'harness_failed', message: 'exit 1' });
    expect(await drain(w)).toEqual({ results: 0, deadLetters: 1 });
    expect((await rowOf(w, runId)).failure).toEqual({ kind: 'harness_failed', message: 'exit 1' });
  });

  test("pg-boss's timeout output maps to expired and any other kind-less output to unknown", async () => {
    const expiredRun = await newRun();
    // Every attempt but the last fails; the last one expires under pg-boss's own supervision.
    let job = await w.runner.take();
    while (job.retryCount < job.retryLimit) {
      await w.runner.fail(job, { kind: 'daemon_unreachable', message: 'retry' });
      job = await w.runner.take();
    }
    await w.testDb.db.execute(
      sql`UPDATE pgboss_exec.job SET started_on = now() - interval '1 hour' WHERE id = ${job.id}`,
    );
    await w.boss.supervise(RUN_QUEUE);
    const after = await w.boss.getJobById(RUN_QUEUE, job.id);
    expect(after?.state).toBe('failed');
    expect(after?.output).toEqual({ value: { message: 'job timed out' } });
    expect(await drain(w)).toEqual({ results: 0, deadLetters: 1 });
    expect((await rowOf(w, expiredRun)).failure).toEqual({
      kind: 'expired',
      message: 'job timed out',
    });

    const unknownRun = await newRun();
    await w.runner.failUntilDeadLetter({
      name: 'TypeError',
      message: 'x is undefined',
      stack: 'at y',
    });
    expect(await drain(w)).toEqual({ results: 0, deadLetters: 1 });
    expect((await rowOf(w, unknownRun)).failure).toEqual({
      kind: 'unknown',
      message: 'x is undefined',
    });
  });

  test('a failed grading job settled on read moves the attempt to NeedsReview, as the dead letter would', async () => {
    const graded = await startAttempt(w, 'sam', ids.classB);
    tick();
    const submitted = await call(w, 'sam', 'POST', `${attemptUrl(ids.classB, graded)}/submit`, {
      submissionKey: 'results-grading-1',
    });
    expect(submitted.status).toBe(200);
    await w.runner.failUntilDeadLetter({ kind: 'image_unavailable', message: 'gone' });
    // An instructor's read lands before the dead letter is worked.
    const results = await call(w, 'marcus', 'GET', `${attemptUrl(ids.classB, graded)}/results`);
    const failed = results.body.runs.find(
      (r: { state: string }) => r.state === 'infrastructure_error',
    );
    expect(failed).toMatchObject({ reason: 'grading', failure: { kind: 'image_unavailable' } });
    const state = async () =>
      (await w.testDb.db.select().from(testAttempts).where(eq(testAttempts.id, graded)))[0]?.state;
    expect(await state()).toBe('needs_review');
    expect(await drain(w)).toMatchObject({ deadLetters: 1 });
    expect(await state()).toBe('needs_review');
    expect((await rowOf(w, failed.runId)).failure).toEqual({
      kind: 'image_unavailable',
      message: 'gone',
    });
    // The other grading jobs are left to run out.
    await w.runner.finish(await w.runner.take());
    await w.runner.finish(await w.runner.take());
    await drain(w);
  });

  test('a cancelled job settles the row cancelled, not infrastructure_error', async () => {
    const runId = await newRun();
    // A cancel that died between `bossExec.cancel` and its row update.
    await w.boss.cancel(RUN_QUEUE, (await rowOf(w, runId)).bossJobId);
    expect((await read(runId)).body.state).toBe('cancelled');
    expect((await rowOf(w, runId)).failure).toBeNull();
  });

  test('a row whose run job is gone while its result message is still queued is settled from the message, not lost', async () => {
    const runId = await newRun();
    const job = await w.runner.take();
    await w.runner.finish(job);
    await w.boss.deleteJob(RUN_QUEUE, job.id);
    expect((await read(runId)).body).toMatchObject({
      state: 'passed',
      result: { status: 'passed' },
    });
    expect(await rowOf(w, runId)).toMatchObject({ startedAt: null, infrastructureAttempts: null });
    await drain(w);
  });

  test('a row whose job never appeared is queued within the send window, then enqueue_failed while job_sent_at is null and lost once it is set', async () => {
    const source = await newRun();
    await cancel(source);
    const fresh = await cloneRow(w, source, {
      queuedAt: new Date(w.clock.now.getTime() - 10_000),
      jobSentAt: null,
    });
    expect((await read(fresh.id)).body).toEqual(expect.objectContaining({ state: 'queued' }));
    expect((await read(fresh.id)).body.queuePosition).toBeUndefined();
    const unsent = await cloneRow(w, source, {
      queuedAt: new Date(w.clock.now.getTime() - 120_000),
      jobSentAt: null,
    });
    expect((await read(unsent.id)).body.state).toBe('infrastructure_error');
    expect((await rowOf(w, unsent.id)).failure).toMatchObject({ kind: 'enqueue_failed' });
    const sent = await cloneRow(w, source, {
      queuedAt: new Date(w.clock.now.getTime() - 120_000),
      jobSentAt: new Date(w.clock.now.getTime() - 119_000),
    });
    expect((await read(sent.id)).body.state).toBe('infrastructure_error');
    expect((await rowOf(w, sent.id)).failure).toMatchObject({ kind: 'lost' });
    await cancel(fresh.id);
  });

  test('a row with a queued result message is settled from it whatever job_sent_at holds', async () => {
    const source = await newRun();
    await cancel(source);
    for (const jobSentAt of [null, new Date(w.clock.now.getTime() - 119_000)]) {
      const row = await cloneRow(w, source, {
        queuedAt: new Date(w.clock.now.getTime() - 120_000),
        jobSentAt,
      });
      // The job ran and was deleted; the runner's message waits (design §7.5).
      const outcome = outcomeFor({ ...(await jobLike()), jobId: row.id });
      await w.runner.boss.send(RESULT_QUEUE, outcome, { id: row.id, singletonKey: row.id });
      expect((await read(row.id)).body.state).toBe('passed');
      expect(await resultsOf(w, row.id)).toHaveLength(1);
    }
    await drain(w);
  });

  test('a dead letter worked after a lost read replaces failure with its kind', async () => {
    const runId = await newRun();
    const failedId = await w.runner.failUntilDeadLetter({
      kind: 'daemon_unreachable',
      message: 'socket',
    });
    // The failed run job is deleted before the worker gets to its dead letter.
    await w.boss.deleteJob(RUN_QUEUE, failedId);
    expect((await read(runId)).body.state).toBe('infrastructure_error');
    expect((await rowOf(w, runId)).failure).toMatchObject({ kind: 'lost' });
    expect(await drain(w)).toEqual({ results: 0, deadLetters: 1 });
    expect(await rowOf(w, runId)).toMatchObject({
      state: 'infrastructure_error',
      failure: { kind: 'daemon_unreachable', message: 'socket' },
    });
  });
});

/** A job document of the quiz's `mean` question, for building outcomes. */
async function jobLike() {
  const source = await newRun();
  const job = await w.runner.take();
  await w.runner.finish(job);
  await drain(w);
  expect((await rowOf(w, source)).state).toBe('passed');
  return job.data;
}

describe('the send and its races (§2 step 4)', () => {
  test('a send whose row was cancelled meanwhile cancels its job', async () => {
    tick();
    const boss = wrapSend(async (send, jobId) => {
      // The student's cancel lands between the commit and the send.
      await w.testDb.db.execute(
        sql`UPDATE execution_jobs SET state = 'cancelled', finished_at = now() WHERE id = ${jobId} AND state = 'queued'`,
      );
      return send();
    });
    const out = await requestRunService(
      w.testDb.db,
      () => depsWith(boss),
      samA(),
      attempt,
      'mean',
      files(`# ${randomUUID()}\n`),
      w.clock.now,
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.value.state).toBe('cancelled');
    const row = await rowOf(w, out.value.runId);
    expect(row.jobSentAt).toBeNull();
    expect((await w.boss.getJobById(RUN_QUEUE, row.bossJobId))?.state).toBe('cancelled');
  });

  test('a row settled with a result before the post-send update is answered with its terminal state', async () => {
    tick();
    const boss = wrapSend(async (send) => {
      const id = await send();
      // A slot fetches and finishes, and the worker records it, before the update runs.
      await w.runner.finish(await w.runner.take());
      await drain(w);
      return id;
    });
    const out = await requestRunService(
      w.testDb.db,
      () => depsWith(boss),
      samA(),
      attempt,
      'mean',
      files(`# ${randomUUID()}\n`),
      w.clock.now,
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.value).toMatchObject({ state: 'passed', result: { status: 'passed' } });
    const row = await rowOf(w, out.value.runId);
    expect(row.jobSentAt).toBeNull();
    expect((await w.boss.getJobById(RUN_QUEUE, row.bossJobId))?.state).toBe('completed');
  });

  test('a read deciding enqueue_failed before a slow send lands leaves one winner and the job cancelled', async () => {
    tick();
    const boss = wrapSend(async (send, jobId) => {
      // The send outlasts the window; a read decides the run was never queued.
      w.clock.now = new Date(w.clock.now.getTime() + 61_000);
      expect((await read(jobId)).body.state).toBe('infrastructure_error');
      return send();
    });
    const out = await requestRunService(
      w.testDb.db,
      () => depsWith(boss),
      samA(),
      attempt,
      'median',
      files(`# ${randomUUID()}\n`),
      w.clock.now,
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.value.state).toBe('infrastructure_error');
    const row = await rowOf(w, out.value.runId);
    expect(row).toMatchObject({ jobSentAt: null, failure: { kind: 'enqueue_failed' } });
    expect((await w.boss.getJobById(RUN_QUEUE, row.bossJobId))?.state).toBe('cancelled');
  });

  test('a read-path enqueue_failed that lands after the send cancels the job by id', async () => {
    tick();
    const boss = wrapSend(async (send, jobId) => {
      const id = await send();
      // The read looked the job up before the send inserted it, and writes after it landed.
      const blind = new Proxy(w.boss, {
        get(target, prop) {
          if (prop === 'getJobById') return async () => null;
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const row = await rowOf(w, jobId);
      const late = new Date(w.clock.now.getTime() + 61_000);
      const decided = await readState(w.testDb.db, { ...queues(), boss: blind }, row, late);
      expect(decided.row.state).toBe('infrastructure_error');
      return id;
    });
    const out = await requestRunService(
      w.testDb.db,
      () => depsWith(boss),
      samA(),
      attempt,
      'spread',
      files(`# ${randomUUID()}\n`),
      w.clock.now,
    );
    if (!out.ok) throw new Error(JSON.stringify(out));
    const row = await rowOf(w, out.value.runId);
    expect(row).toMatchObject({ state: 'infrastructure_error', jobSentAt: null });
    expect((await w.boss.getJobById(RUN_QUEUE, row.bossJobId))?.state).toBe('cancelled');
  });

  test('a send that lands and is marked first wins over a later read', async () => {
    const runId = await newRun();
    tick(61_000);
    expect((await read(runId)).body.state).toBe('queued');
    expect((await rowOf(w, runId)).jobSentAt).not.toBeNull();
    await cancel(runId);
    const settled = await w.testDb.db.select().from(executionResults);
    expect(settled.every((r) => r.jobId !== runId)).toBe(true);
  });
});
