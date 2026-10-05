import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executionJobs } from '../../src/db/schema';
import { RUN_QUEUE } from '../../src/execution/queues';
import { ids } from '../fixtures/world';
import {
  attemptUrl,
  call,
  cloneRow,
  type ExecWorld,
  execWorld,
  requestRun,
  rowOf,
  startAttempt,
} from './execution';

/**
 * A13 (API cap; docs/design/runner.md §2 step 3, §5, §8.5): two sample runs queued or running per
 * student across every class, counting only rows the staleness rule calls live, looked up in one
 * statement, and never writing to the rows it counts.
 */

let w: ExecWorld;
let attempt: string;

beforeEach(async () => {
  w = await execWorld();
  attempt = await startAttempt(w, 'sam', ids.classA);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
});

const tick = (ms = 1000) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms);
};
const run = (question: string, code = `# ${question}\n`) => {
  tick();
  return requestRun(w, 'sam', ids.classA, attempt, question, code);
};
const CAP_BODY = {
  error: 'too_many_runs',
  active: 2,
  message: 'Two runs are already queued or running. Wait for one to finish.',
};

describe('A13 per-student run cap', () => {
  test('A13 two sample runs are accepted and a third answers 429 with the queue message', async () => {
    expect((await run('mean')).status).toBe(202);
    expect((await run('median')).status).toBe(202);
    const third = await run('spread');
    expect(third.status).toBe(429);
    expect(third.body).toEqual(CAP_BODY);
  });

  test('A13 the cap ignores grading runs', async () => {
    tick();
    const submitted = await call(w, 'sam', 'POST', `${attemptUrl(ids.classA, attempt)}/submit`, {
      submissionKey: 'cap-grading-1',
    });
    expect(submitted.status).toBe(200);
    const grading = await w.testDb.db
      .select()
      .from(executionJobs)
      .where(eq(executionJobs.reason, 'grading'));
    expect(grading).toHaveLength(3);
    attempt = await startAttempt(w, 'sam', ids.classA);
    expect((await run('mean')).status).toBe(202);
    expect((await run('median')).status).toBe(202);
  });

  test('A13 a new run for the same question supersedes the queued one', async () => {
    const first = await run('mean', 'def mean(xs):\n    return 0\n');
    await run('median');
    const second = await run('mean', 'def mean(xs):\n    return 1\n');
    expect(second.status).toBe(202);
    const old = await rowOf(w, first.body.runId);
    expect(old).toMatchObject({ state: 'cancelled', supersededBy: second.body.runId });
    expect((await w.boss.getJobById(RUN_QUEUE, old.bossJobId))?.state).toBe('cancelled');
    // Still two live runs: median and the new mean.
    expect((await run('spread')).status).toBe(429);
  });

  test('A13 a new run for the same question does not cancel a run a slot already fetched, and counts it', async () => {
    const first = await run('mean', 'def mean(xs):\n    return 0\n');
    await run('median');
    const fetched = await w.runner.take();
    expect(fetched.data.jobId).toBe(first.body.runId);
    const again = await run('mean', 'def mean(xs):\n    return 1\n');
    expect(again.status).toBe(429);
    expect(await rowOf(w, first.body.runId)).toMatchObject({ state: 'queued', supersededBy: null });
    expect((await w.boss.getJobById(RUN_QUEUE, fetched.id))?.state).toBe('active');
    await w.runner.finish(fetched);
    expect((await run('mean', 'def mean(xs):\n    return 1\n')).status).toBe(202);
  });

  test('A13 a queued row whose pg-boss job is still created is counted however old it is', async () => {
    await run('mean');
    await run('median');
    await w.testDb.db
      .update(executionJobs)
      .set({ queuedAt: new Date(w.clock.now.getTime() - 3_600_000) });
    tick(3_600_000);
    const third = await run('spread');
    expect(third.status).toBe(429);
    expect(third.body).toEqual(CAP_BODY);
  });

  test('A13 a queued row whose pg-boss job is gone is not counted and not written', async () => {
    const gone = await run('mean');
    await run('median');
    const before = await rowOf(w, gone.body.runId);
    await w.boss.deleteJob(RUN_QUEUE, before.bossJobId);
    expect((await run('spread')).status).toBe(202);
    expect(await rowOf(w, gone.body.runId)).toEqual(before);
  });

  test('A13 a queued row whose job has not appeared within the send window is not counted', async () => {
    const source = await run('mean');
    await call(
      w,
      'sam',
      'POST',
      `${attemptUrl(ids.classA, attempt)}/runs/${source.body.runId}/cancel`,
    );
    // Committed but never sent: one inside the 60 s window counts, one past it does not.
    await cloneRow(w, source.body.runId, {
      questionId: 'median',
      queuedAt: new Date(w.clock.now.getTime() - 10_000),
      jobSentAt: null,
    });
    const stale = await cloneRow(w, source.body.runId, {
      questionId: 'spread',
      queuedAt: new Date(w.clock.now.getTime() - 120_000),
      jobSentAt: null,
    });
    expect((await run('mean')).status).toBe(202);
    expect((await run('spread')).status).toBe(429);
    expect(await rowOf(w, stale.id)).toMatchObject({ state: 'queued', failure: null });
  });

  test('A13 a queued row whose pg-boss job completed is not counted', async () => {
    const done = await run('mean');
    await run('median');
    const job = await w.runner.take();
    await w.runner.finish(job);
    // Nothing has read or settled the row yet; its job is completed.
    expect((await rowOf(w, done.body.runId)).state).toBe('queued');
    expect((await run('spread')).status).toBe(202);
    expect((await rowOf(w, done.body.runId)).state).toBe('queued');
  });

  test('A13 the cap counts runs in every class and writes nothing to rows of other classes', async () => {
    const other = await startAttempt(w, 'sam', ids.classB);
    tick();
    const inB = await requestRun(w, 'sam', ids.classB, other, 'mean', '# class B\n');
    expect(inB.status).toBe(202);
    const staleInB = await cloneRow(w, inB.body.runId, {
      questionId: 'median',
      queuedAt: new Date(w.clock.now.getTime() - 120_000),
      jobSentAt: new Date(w.clock.now.getTime() - 119_000),
    });
    const before = await rowOf(w, staleInB.id);
    expect((await run('mean')).status).toBe(202);
    const third = await run('median');
    expect(third.status).toBe(429);
    expect(await rowOf(w, staleInB.id)).toEqual(before);
    expect((await rowOf(w, inB.body.runId)).state).toBe('queued');
  });

  test('A13 the cap looks every job up in one statement', async () => {
    const source = await run('mean');
    for (let i = 0; i < 20; i++) {
      await cloneRow(w, source.body.runId, {
        questionId: 'median',
        queuedAt: new Date(w.clock.now.getTime() - 600_000),
        jobSentAt: new Date(w.clock.now.getTime() - 599_000),
      });
    }
    const statements: string[] = [];
    const original = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { text?: string };
      const text = typeof first === 'string' ? first : (first?.text ?? '');
      if (text.includes('pgboss_exec')) statements.push(text);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof pg.Client.prototype.query);
    const posted = await run('spread');
    vi.restoreAllMocks();
    expect(posted.status).toBe(202);
    const lookups = statements.filter((s) => /id = ANY\(/.test(s) && /"?job"? WHERE name/.test(s));
    expect(lookups).toHaveLength(1);
    // Besides it: the send, the post-send cancel guard and one read of the new run's own job.
    const byId = statements.filter((s) => /AND id = \$2/.test(s));
    expect(byId.length).toBeLessThanOrEqual(1);
  });
});
