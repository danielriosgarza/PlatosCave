import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createResource } from '../../src/db/content/drafts';
import * as preview from '../../src/db/preview';
import { classes } from '../../src/db/schema';
import { asCourseScope, ids } from '../fixtures/world';
import { call, type ExecWorld, execWorld, quiz, rowOf } from './execution';

/**
 * P3-18 test authoring (§11, §12; docs/design/runner.md §8.1): publication validation of test
 * content, and instructor preview runs of a draft code question with its hidden checks.
 */

let w: ExecWorld;
const course = `/api/courses/${ids.statistics}`;
const elena = () => asCourseScope(ids.statistics, ids.elena);

beforeAll(async () => {
  w = await execWorld();
});
afterAll(async () => {
  await w?.close();
});

type Question = (typeof quiz.questions)[number];
const code = (over: Record<string, unknown> = {}): Question =>
  ({ ...quiz.questions[0], ...over }) as Question;

const sample = (quiz.questions[0] as { checks: Record<string, unknown>[] }).checks[0];

async function draft(title: string, question: Question) {
  const created = await createResource(
    w.testDb.db,
    elena(),
    ids.sampling,
    { type: 'test', title, content: { questions: [question] } },
    w.clock.now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.value.id;
}

async function report(resourceId: string) {
  const res = await call(w, 'elena', 'GET', `${course}/releases/validation`);
  expect(res.status).toBe(200);
  const mine = (i: { resourceId?: string }) => i.resourceId === resourceId;
  return {
    errors: res.body.errors.filter(mine) as { code: string; message: string }[],
    warnings: res.body.warnings.filter(mine) as { code: string; message: string }[],
  };
}

describe('P3-18 publication validation', () => {
  test('a valid test publishes without findings', async () => {
    const res = await call(w, 'elena', 'GET', `${course}/releases/validation`);
    expect(res.status).toBe(200);
    expect(res.body.errors.filter((e: { code: string }) => e.code === 'invalid_test')).toEqual([]);
  });

  test('publication rejects a runtime outside the approved list and a package outside it', async () => {
    const id = await draft('Bad runtime', code({ runtime: 'python-3.99' }));
    const bad = await report(id);
    expect(bad.errors).toEqual([
      expect.objectContaining({
        code: 'invalid_test',
        message: expect.stringContaining('python-3.99'),
      }),
    ]);
    const id2 = await draft('Bad package', code({ allowedPackages: ['torch'] }));
    expect((await report(id2)).errors[0]?.message).toMatch(/package torch/);
  });

  test('publication rejects a file path that is a directory prefix of another', async () => {
    const q = code();
    const id = await draft(
      'Prefix',
      code({
        files: [
          ...(q as unknown as { files: unknown[] }).files,
          { path: 'data', content: 'x', editable: false, hidden: false },
          { path: 'data/sample.csv', content: '1', editable: false, hidden: false },
        ],
      }),
    );
    expect((await report(id)).errors[0]?.message).toMatch(/directory prefix/);
  });

  test('publication warns on script-only hidden checks without blocking the release', async () => {
    const q = code({
      files: [
        ...(code() as unknown as { files: unknown[] }).files,
        { path: 'tests/check.py', content: 'print(1)\n', editable: false, hidden: true },
      ],
      checks: [
        sample,
        {
          name: 'hidden-script',
          kind: 'script',
          visibility: 'hidden',
          file: 'tests/check.py',
          files: ['solution.py'],
        },
      ],
    });
    const id = await draft('Script only', q);
    const found = await report(id);
    expect(found.errors).toEqual([]);
    expect(found.warnings).toEqual([
      expect.objectContaining({ code: 'script_only_hidden_checks' }),
    ]);
  });

  test('content that is not test.v1 is reported by validation and blocks the release', async () => {
    const created = await createResource(
      w.testDb.db,
      elena(),
      ids.sampling,
      { type: 'test', title: 'Half done', content: { questions: [{ id: 'q1', prompt: 'x' }] } },
      w.clock.now,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const found = await report(created.value.id);
    expect(found.errors).toEqual([expect.objectContaining({ code: 'invalid_test' })]);
    const published = await call(w, 'elena', 'POST', `${course}/releases`);
    expect(published.status).toBe(422);
  });
});

describe('P3-18 instructor preview runs', () => {
  let resourceId: string;
  let runId: string;
  const url = () => `${course}/resources/${resourceId}/questions/mean/preview-runs`;

  test('an instructor runs the hidden checks of a draft question in the preview class', async () => {
    resourceId = await draft('Preview me', code());
    const posted = await call(w, 'marcus', 'POST', url(), {
      set: 'full',
      files: [{ path: 'solution.py', content: 'def mean(xs):\n    return sum(xs) / len(xs)\n' }],
    });
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({ state: 'queued', reason: 'preview', checkSet: 'full' });
    runId = posted.body.runId;

    const job = await w.runner.take();
    expect(job.data).toMatchObject({ set: 'full', jobId: runId });
    expect(job.data.checks.map((c) => c.name)).toEqual(['sample', 'hidden-large']);
    await w.runner.finish(job);

    const read = await call(w, 'marcus', 'GET', `${course}/preview-runs/${runId}`);
    expect(read.status).toBe(200);
    expect(read.body.state).toBe('passed');
    // The editor sees the hidden check's outcome.
    expect(read.body.result.outcome.result.checks.map((c: { name: string }) => c.name)).toEqual([
      'sample',
      'hidden-large',
    ]);
  });

  test('a preview run has no attempt, belongs to the preview principal and is not capped', async () => {
    const row = await rowOf(w, runId);
    expect(row).toMatchObject({
      attemptId: null,
      context: 'preview',
      reason: 'preview',
      userId: ids.previewB,
      classId: ids.classB,
      requestedBy: ids.marcus,
    });
    for (let i = 0; i < 3; i++) {
      const more = await call(w, 'marcus', 'POST', url(), { set: 'public' });
      expect(more.status).toBe(202);
      expect(more.body.checkSet).toBe('public');
    }
  });

  test('a sample-only preview run sends no hidden check or hidden file', async () => {
    const job = await w.runner.take();
    expect(job.data.set).toBe('public');
    expect(JSON.stringify(job.data)).not.toMatch(/hidden-large|large\.txt/);
  });

  test('students, other editors’ runs and an instructor without a class are refused', async () => {
    const asStudent = await call(w, 'sam', 'POST', url(), { set: 'full' });
    expect([403, 404]).toContain(asStudent.status);
    const noClass = await call(w, 'elena', 'POST', url(), { set: 'full' });
    expect(noClass.status).toBe(409);
    expect(noClass.body.error).toBe('no_class');
    // Elena has no preview principal, so Marcus's run is not hers to read.
    const other = await call(w, 'elena', 'GET', `${course}/preview-runs/${runId}`);
    expect(other.status).toBe(404);
  });

  test('an unfinished draft, an unknown question and a non-test resource are not run', async () => {
    const unknown = await call(
      w,
      'marcus',
      'POST',
      `${course}/resources/${resourceId}/questions/nope/preview-runs`,
      { set: 'full' },
    );
    expect(unknown.status).toBe(404);
    const choice = await call(
      w,
      'marcus',
      'POST',
      `${course}/resources/${w.quizId}/questions/pick/preview-runs`,
      { set: 'full' },
    );
    expect(choice.status).toBe(404);
    const reading = await call(
      w,
      'marcus',
      'POST',
      `${course}/resources/${ids.samplingReading}/questions/mean/preview-runs`,
      { set: 'full' },
    );
    expect(reading.status).toBe(404);
  });

  test('a preview run stays readable after its class is archived', async () => {
    // Archiving the class leaves Marcus no live class to start a preview run in, but the run
    // he started there is still his to read.
    await w.testDb.db
      .update(classes)
      .set({ archivedAt: w.clock.now })
      .where(eq(classes.id, ids.classB));
    try {
      const read = await call(w, 'marcus', 'GET', `${course}/preview-runs/${runId}`);
      expect(read.status).toBe(200);
      expect(read.body.runId).toBe(runId);
      const fresh = await call(w, 'marcus', 'POST', url(), { set: 'public' });
      expect(fresh.status).toBe(409);
    } finally {
      await w.testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classB));
    }
  });

  test('a class archived after it was picked answers its own declared 409', async () => {
    const picked = preview.previewRunClass;
    let archived = '';
    const spy = vi.spyOn(preview, 'previewRunClass').mockImplementation(async (db, scope) => {
      const home = await picked(db, scope);
      archived = home?.classId ?? '';
      // The class is archived between the pick and the run being queued.
      await db.update(classes).set({ archivedAt: w.clock.now }).where(eq(classes.id, archived));
      return home;
    });
    try {
      const res = await call(w, 'marcus', 'POST', url(), { set: 'public' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'class_archived' });
    } finally {
      spy.mockRestore();
      await w.testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, archived));
    }
  });
});
