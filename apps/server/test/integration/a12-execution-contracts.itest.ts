import {
  cancelRun,
  latestRun,
  readRun,
  requestRun as requestRunContract,
  studentRun,
} from '@parallax/contracts/routes/runs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { codeHash } from '../../src/execution/job-builder';
import { RUN_QUEUE } from '../../src/execution/queues';
import { ids } from '../fixtures/world';
import {
  attemptUrl,
  call,
  type ExecWorld,
  execWorld,
  files,
  requestRun,
  rowOf,
  startAttempt,
} from './execution';

/**
 * A12 (§11; docs/design/runner.md §8.6): sample output names the exact snapshot it ran, hidden
 * checks never reach a student response, and a student's routes never serve a grading run.
 */

let w: ExecWorld;
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
};

beforeAll(async () => {
  w = await execWorld();
});
afterAll(async () => {
  await w?.close();
});

const CODE = 'def mean(xs):\n    return sum(xs) / len(xs)\n';
let firstAttempt: string;
let firstRun: string;

/** Every property name of a JSON Schema, at any depth. */
function keysOf(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) keysOf(s, out);
  else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const name of Object.keys(value)) out.add(name);
      }
      keysOf(value, out);
    }
  }
  return out;
}

describe('A12 execution contracts', () => {
  test('A12 a sample run names the code hash of the snapshot it ran', async () => {
    firstAttempt = await startAttempt(w, 'sam', ids.classA);
    tick();
    const posted = await requestRun(w, 'sam', ids.classA, firstAttempt, 'mean', CODE);
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({
      state: 'queued',
      reused: false,
      codeHash: codeHash({ files: files(CODE) }),
      queuePosition: 0,
    });
    firstRun = posted.body.runId;

    const job = await w.runner.take();
    expect(job.data.jobId).toBe(firstRun);
    const running = await call(
      w,
      'sam',
      'GET',
      `${attemptUrl(ids.classA, firstAttempt)}/runs/${firstRun}`,
    );
    expect(running.body.state).toBe('running');
    await w.runner.finish(job);

    const read = await call(
      w,
      'sam',
      'GET',
      `${attemptUrl(ids.classA, firstAttempt)}/runs/${firstRun}`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      runId: firstRun,
      state: 'passed',
      codeHash: codeHash({ files: files(CODE) }),
      result: { status: 'passed', runtime: { language: 'python', version: '3.12.8' } },
    });
    expect(read.body.result.checks.map((c: { name: string }) => c.name)).toEqual(['sample']);
    // The editor labels output stale by comparing this hash with its content's.
    expect(read.body.codeHash).not.toBe(codeHash({ files: files(`${CODE}# edited\n`) }));
  });

  test('A12 the job a sample run sends carries no hidden check, hidden file or points', async () => {
    const row = await rowOf(w, firstRun);
    const job = await w.boss.getJobById<Record<string, unknown>>(RUN_QUEUE, row.bossJobId);
    const text = JSON.stringify(job?.data);
    expect(job?.data).toMatchObject({ set: 'public', jobId: firstRun });
    expect(text).not.toMatch(
      /hidden-large|large\.txt|"hidden":true|"points"|"visibility":"hidden"/,
    );
  });

  test('A12 identical files reuse the run of the same attempt but never of another attempt', async () => {
    tick();
    const again = await requestRun(w, 'sam', ids.classA, firstAttempt, 'mean', CODE);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ runId: firstRun, reused: true, state: 'passed' });

    tick();
    const submitted = await call(
      w,
      'sam',
      'POST',
      `${attemptUrl(ids.classA, firstAttempt)}/submit`,
      {
        submissionKey: 'a12-submit-1',
      },
    );
    expect(submitted.status).toBe(200);
    tick();
    const second = await startAttempt(w, 'sam', ids.classA);
    expect(second).not.toBe(firstAttempt);
    tick();
    const fresh = await requestRun(w, 'sam', ids.classA, second, 'mean', CODE);
    expect(fresh.status).toBe(202);
    expect(fresh.body.reused).toBe(false);
    expect(fresh.body.runId).not.toBe(firstRun);
    await call(
      w,
      'sam',
      'POST',
      `${attemptUrl(ids.classA, second)}/runs/${fresh.body.runId}/cancel`,
    );
  });

  test('A12 files that are not the question’s editable files, or hold a lone surrogate, are refused with 400', async () => {
    const attempt = await startAttempt(w, 'bea', ids.classB);
    const url = `${attemptUrl(ids.classB, attempt)}/questions/mean/runs`;
    const lone = await call(w, 'bea', 'POST', url, {
      files: [{ path: 'solution.py', content: 'x = "\ud800"\n' }],
    });
    expect(lone.status).toBe(400);
    const hidden = await call(w, 'bea', 'POST', url, {
      files: [{ path: 'large.txt', content: '1' }],
    });
    expect(hidden.status).toBe(400);
    expect(hidden.body).toEqual({
      error: 'invalid',
      message: 'Only this question’s editable files can be run',
    });
  });

  test('A12 no key of a student response schema names hidden material', () => {
    const forbidden = /hidden|visibility|points/i;
    for (const schema of [
      studentRun,
      requestRunContract.response,
      cancelRun.response,
      readRun.response.options[0],
      z.object({ run: latestRun.response.shape.run.unwrap().options[0] }),
    ]) {
      const keys = [...keysOf(z.toJSONSchema(schema))];
      expect(keys.length).toBeGreaterThan(5);
      expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
    }
    // Strict: an outcome field the schema does not name cannot leak through it.
    expect(
      studentRun.safeParse({
        runId: firstRun,
        state: 'passed',
        codeHash: 'x',
        queuedAt: new Date().toISOString(),
        visibility: 'hidden',
      }).success,
    ).toBe(false);
  });

  test('A12 student routes answer 404 for a grading run and ?latest=1 never selects one', async () => {
    const results = await call(
      w,
      'priya',
      'GET',
      `${attemptUrl(ids.classA, firstAttempt)}/results`,
    );
    expect(results.status).toBe(200);
    const grading = results.body.runs.find(
      (r: { reason: string; questionId: string }) =>
        r.reason === 'grading' && r.questionId === 'mean',
    );
    expect(grading).toMatchObject({ checkSet: 'full', state: 'queued' });
    const base = attemptUrl(ids.classA, firstAttempt);
    expect((await call(w, 'sam', 'GET', `${base}/runs/${grading.runId}`)).status).toBe(404);
    expect((await call(w, 'sam', 'POST', `${base}/runs/${grading.runId}/cancel`)).status).toBe(404);
    const latest = await call(w, 'sam', 'GET', `${base}/questions/mean/runs?latest=1`);
    expect(latest.status).toBe(200);
    expect(latest.body.run.runId).toBe(firstRun);
    // Another student of the class cannot read Sam's sample run either.
    expect((await call(w, 'bea', 'GET', `${base}/runs/${firstRun}`)).status).toBe(404);
  });

  test('A12 a stored full outcome shown to an instructor still holds its hidden checks', async () => {
    // The grading jobs of the submitted attempt, in question order (priority 5, after samples).
    for (let i = 0; i < 3; i++) {
      const job = await w.runner.take();
      expect(job.data.set).toBe('full');
      await w.runner.finish(job);
    }
    const results = await call(
      w,
      'priya',
      'GET',
      `${attemptUrl(ids.classA, firstAttempt)}/results`,
    );
    const grading = results.body.runs.find(
      (r: { reason: string; questionId: string }) =>
        r.reason === 'grading' && r.questionId === 'mean',
    );
    expect(grading.state).toBe('passed');
    const names = grading.result.outcome.result.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(['sample', 'hidden-large']);
    const one = await call(
      w,
      'priya',
      'GET',
      `${attemptUrl(ids.classA, firstAttempt)}/runs/${grading.runId}`,
    );
    expect(one.body.result.outcome.result.checks).toHaveLength(2);
  });
});
