import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ids } from '../fixtures/world';
import { attemptUrl, call, type ExecWorld, execWorld, requestRun, startAttempt } from './execution';

/**
 * P4-AUD5: the instructor run routes read the same attempts as review, grading and export
 * (`reviewable`, ADR-0002): a real student's, removed students included. A preview principal's
 * attempt answers 404 to an instructor, as an attempt of another class does, so its runs and
 * hidden-check results cannot be read and no replay can be queued on it. Marcus teaches class B;
 * previewB is his preview principal there.
 */

let w: ExecWorld;
let beaAttempt: string;
let previewAttempt: string;
let priyaAttempt: string;
let previewRun: string;

beforeAll(async () => {
  w = await execWorld();
  beaAttempt = await startAttempt(w, 'bea', ids.classB);
  priyaAttempt = await startAttempt(w, 'priya', ids.classB);
  previewAttempt = await startAttempt(w, 'previewB', ids.classB);
  const run = await requestRun(w, 'previewB', ids.classB, previewAttempt, 'mean', '# mean\n');
  expect(run.status).toBe(202);
  previewRun = run.body.runId;
});
afterAll(async () => {
  await w?.close();
});

describe('A21 instructor run routes exclude preview attempts', () => {
  test('A21 an instructor reads the results of a student attempt but gets 404 for a preview attempt', async () => {
    const student = await call(w, 'marcus', 'GET', `${attemptUrl(ids.classB, beaAttempt)}/results`);
    expect(student.status).toBe(200);
    const preview = await call(
      w,
      'marcus',
      'GET',
      `${attemptUrl(ids.classB, previewAttempt)}/results`,
    );
    expect(preview.status).toBe(404);
    expect(JSON.stringify(preview.body)).not.toContain(previewRun);
  });

  test('A21 an instructor reads no run of a preview attempt', async () => {
    const base = attemptUrl(ids.classB, previewAttempt);
    const read = await call(w, 'marcus', 'GET', `${base}/runs/${previewRun}`);
    const latest = await call(w, 'marcus', 'GET', `${base}/questions/mean/runs?latest=1`);
    expect([read.status, latest.status]).toEqual([404, 404]);
    // The preview principal still reads its own run.
    expect((await call(w, 'previewB', 'GET', `${base}/runs/${previewRun}`)).status).toBe(200);
  });

  test('A21 results of a removed student’s attempt stay readable to the instructor', async () => {
    const removed = await call(
      w,
      'elena',
      'DELETE',
      `/api/classes/${ids.classB}/members/${ids.priya}`,
    );
    expect(removed.status).toBe(200);
    const res = await call(w, 'marcus', 'GET', `${attemptUrl(ids.classB, priyaAttempt)}/results`);
    expect(res.status).toBe(200);
  });
});

describe('A18 instructor replay excludes preview attempts', () => {
  test('A18 an instructor’s replay on a preview attempt answers 404 and queues nothing', async () => {
    const preview = await call(
      w,
      'marcus',
      'POST',
      `${attemptUrl(ids.classB, previewAttempt)}/questions/mean/replays`,
      { reason: 'replay', note: 'probe' },
    );
    expect(preview.status).toBe(404);
    // The same request on a student's attempt is found; it is still open, so it is refused as such.
    const student = await call(
      w,
      'marcus',
      'POST',
      `${attemptUrl(ids.classB, beaAttempt)}/questions/mean/replays`,
      { reason: 'replay', note: 'probe' },
    );
    expect(student.status).toBe(409);
    expect(student.body).toMatchObject({ error: 'attempt_open' });
  });
});
