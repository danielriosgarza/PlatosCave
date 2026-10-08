import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents } from '../../src/db/schema';
import { RUN_QUEUE } from '../../src/execution/queues';
import { ids } from '../fixtures/world';
import { call, type ExecWorld, execWorld, requestRun, rowOf, startAttempt } from './execution';

/**
 * Removing a student cancels their queued sample runs in that class (P3-AUD2; ADR-0002
 * "Permission revoked", docs/design/runner.md §8.4): the rows are cancelled in the removing
 * transaction and their pg-boss jobs after it, so nothing of theirs still waiting is sent to the
 * runner. A run a slot already fetched finishes as usual, and nobody else's run is touched. Sam
 * studies in classes A and B.
 */

let w: ExecWorld;

beforeEach(async () => {
  w = await execWorld();
});
afterEach(async () => {
  await w?.close();
});

const tick = (ms = 1000) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms);
};

describe('A13 a removed student’s queued runs are not sent to the runner', () => {
  test('A13 removal cancels the student’s queued sample runs in that class and leaves fetched and others’ runs', async () => {
    const samB = await startAttempt(w, 'sam', ids.classB);
    const beaB = await startAttempt(w, 'bea', ids.classB);
    tick();
    const fetchedRun = await requestRun(w, 'sam', ids.classB, samB, 'mean', '# mean\n');
    const fetched = await w.runner.take();
    expect(fetched.data.jobId).toBe(fetchedRun.body.runId);
    tick();
    const queuedRun = await requestRun(w, 'sam', ids.classB, samB, 'median', '# median\n');
    tick();
    const beaRun = await requestRun(w, 'bea', ids.classB, beaB, 'mean', '# mean\n');
    for (const r of [fetchedRun, queuedRun, beaRun]) expect(r.status).toBe(202);

    tick();
    const removed = await call(
      w,
      'elena',
      'DELETE',
      `/api/classes/${ids.classB}/members/${ids.sam}`,
    );
    expect(removed).toMatchObject({ status: 200, body: { removed: true } });

    const cancelled = await rowOf(w, queuedRun.body.runId);
    expect(cancelled).toMatchObject({ state: 'cancelled', finishedAt: w.clock.now });
    expect((await w.boss.getJobById(RUN_QUEUE, cancelled.bossJobId))?.state).toBe('cancelled');
    const events = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'execution.cancelled'),
          eq(auditEvents.targetId, queuedRun.body.runId),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: ids.elena,
      scopeKind: 'class',
      scopeId: ids.classB,
      after: { reason: 'membership_removed' },
    });

    // The run a slot already fetched is left to finish; Bea's run waits as before.
    expect(await rowOf(w, fetchedRun.body.runId)).toMatchObject({ state: 'queued' });
    expect((await w.boss.getJobById(RUN_QUEUE, fetched.id))?.state).toBe('active');
    const bea = await rowOf(w, beaRun.body.runId);
    expect(bea).toMatchObject({ state: 'queued' });
    expect((await w.boss.getJobById(RUN_QUEUE, bea.bossJobId))?.state).toBe('created');

    // The runner's next job is Bea's: nothing of Sam's that was waiting reaches it.
    const next = await w.runner.take();
    expect(next.data.jobId).toBe(beaRun.body.runId);
  });

  test('A13 removal leaves the student’s runs in their other class alone', async () => {
    const samA = await startAttempt(w, 'sam', ids.classA);
    tick();
    const runA = await requestRun(w, 'sam', ids.classA, samA, 'mean', '# mean\n');
    expect(runA.status).toBe(202);
    tick();
    const removed = await call(
      w,
      'elena',
      'DELETE',
      `/api/classes/${ids.classB}/members/${ids.sam}`,
    );
    expect(removed.status).toBe(200);
    const row = await rowOf(w, runA.body.runId);
    expect(row).toMatchObject({ state: 'queued' });
    expect((await w.boss.getJobById(RUN_QUEUE, row.bossJobId))?.state).toBe('created');
  });
});
