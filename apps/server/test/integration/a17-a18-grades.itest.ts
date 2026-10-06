import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  auditEvents,
  gradeOverrides,
  gradeReleases,
  grades,
  testAttempts,
} from '../../src/db/schema';
import type { PersonName } from '../fixtures/world';
import { ids } from '../fixtures/world';
import { attemptUrl, call, drain, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * Grades (§11, §12): A17 a draft grade is invisible to its student, and releasing selected
 * feedback makes exactly those results visible and records actor, time and recipients; A18 a
 * grading run lost to an infrastructure failure leaves the attempt in NeedsReview without a
 * grade, and an override keeps the prior result and records its reason. Class B: Marcus
 * teaches Bea, Priya and Sam.
 */

let w: ExecWorld;
const attempt: Partial<Record<PersonName, string>> = {};
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 60_000);
  return w.clock.now;
};
/** An attempt id of no student of class B. */
const FOREIGN = '00000000-0000-4000-8000-00000000f00d';
const CODE = 'def f(xs):\n    return 2\n';

async function put(who: PersonName, url: string, payload: object) {
  const res = await w.app.inject({
    method: 'PUT',
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
    payload,
  });
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

const gradeUrl = (who: PersonName) => `${attemptUrl(ids.classB, attempt[who] as string)}/grade`;
const resultsUrl = () => `/api/classes/${ids.classB}/resources/${w.quizId}/results`;
const releaseUrl = `/api/classes/${ids.classB}/grade-releases`;
const readGrade = (who: PersonName) => call(w, 'marcus', 'GET', gradeUrl(who));
const results = (who: PersonName) => call(w, who, 'GET', resultsUrl());

/** Rubric-free test: choice and code questions only, so a draft needs no manual marks. */
const saveDraft = (who: PersonName, expectedGradeId: string | null, text: string) =>
  call(w, 'marcus', 'POST', gradeUrl(who), {
    expectedGradeId,
    manual: [],
    feedback: [
      { target: { kind: 'attempt' }, text },
      {
        target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
        text: 'Hard-coded',
      },
    ],
  });

beforeAll(async () => {
  w = await execWorld();
  for (const who of ['bea', 'priya', 'sam'] as const) {
    tick();
    const id = await startAttempt(w, who, ids.classB);
    attempt[who] = id;
    for (const questionId of ['mean', 'median', 'spread']) {
      const saved = await put(who, `${attemptUrl(ids.classB, id)}/answers/${questionId}`, {
        value: { files: [{ path: 'solution.py', content: CODE }] },
        seq: 1,
      });
      expect(saved.status).toBe(200);
    }
    await put(who, `${attemptUrl(ids.classB, id)}/answers/pick`, { value: ['b'], seq: 1 });
    const submitted = await call(w, who, 'POST', `${attemptUrl(ids.classB, id)}/submit`, {
      submissionKey: `grades-${who}`,
    });
    expect(submitted.status).toBe(200);
  }
  // Bea's grading run of `mean` is lost to the runner; every other grading run passes.
  await w.runner.failUntilDeadLetter({ kind: 'image_unavailable', message: 'no such image' });
  for (let i = 0; i < 8; i++) await w.runner.finish(await w.runner.take());
  expect(await drain(w)).toEqual({ results: 8, deadLetters: 1 });
});
afterAll(async () => {
  await w?.close();
});

describe('A17 draft grades and release', () => {
  test('A17 a saved draft grade is invisible to its student', async () => {
    const before = await readGrade('priya');
    expect(before.status).toBe(200);
    expect(before.body.history).toEqual([]);
    // Every check passed, and `pick` was right: 4 × 3 + 1.
    expect(before.body.automated.map((q: { points: number }) => q.points)).toEqual([4, 4, 4, 1]);

    tick();
    for (const who of ['priya', 'sam'] as const) {
      const saved = await saveDraft(who, null, `Draft note for ${who}`);
      expect(saved.status).toBe(200);
      expect(saved.body.history[0]).toMatchObject({
        number: 1,
        state: 'draft',
        source: 'draft',
        points: 13,
        possible: 13,
        complete: true,
        automatedPoints: 13,
        manualPoints: 0,
      });
      expect(saved.body.attemptState).toBe('graded');
    }

    const seen = await results('priya');
    expect(seen.status).toBe(200);
    expect(seen.body.attempts).toEqual([
      { attemptId: attempt.priya, number: 1, status: 'pending', grade: null },
    ]);
    expect(seen.body.reported).toBeNull();
    expect(JSON.stringify(seen.body)).not.toContain('Draft note');
  });

  test('A17 a draft based on an older grade row is refused with the current grade', async () => {
    const stale = await saveDraft('sam', null, 'Second instructor');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.history).toHaveLength(1);
  });

  test('feedback holding a lone surrogate is refused with 400', async () => {
    const res = await call(w, 'marcus', 'POST', gradeUrl('sam'), {
      expectedGradeId: null,
      manual: [],
      feedback: [{ target: { kind: 'attempt' }, text: 'bad \ud800 text' }],
    });
    expect(res.status).toBe(400);
  });

  test('A17 releasing selected feedback makes exactly those results visible and records actor and time', async () => {
    const preview = await call(w, 'marcus', 'POST', `${releaseUrl}/preview`, {
      attemptIds: [attempt.priya, attempt.sam, attempt.bea, FOREIGN],
    });
    expect(preview.status).toBe(200);
    expect(
      preview.body.recipients.map((r: { student: { name: string } }) => r.student.name).sort(),
    ).toEqual(['Priya Nair', 'Sam Okafor'].sort());
    expect(preview.body.skipped).toEqual([
      { attemptId: attempt.bea, reason: 'no_grade' },
      { attemptId: FOREIGN, reason: 'not_found' },
    ]);

    // Release only Priya's.
    const priya = preview.body.recipients.find(
      (r: { attemptId: string }) => r.attemptId === attempt.priya,
    );
    const at = tick();
    const released = await call(w, 'marcus', 'POST', releaseUrl, {
      grades: [{ attemptId: attempt.priya, gradeId: priya.gradeId }],
    });
    expect(released.status).toBe(201);
    expect(released.body).toMatchObject({ releasedBy: ids.marcus, releasedAt: at.toISOString() });
    expect(released.body.recipients.map((r: { gradeId: string }) => r.gradeId)).toEqual([
      priya.gradeId,
    ]);

    const [row] = await w.testDb.db
      .select()
      .from(gradeReleases)
      .where(eq(gradeReleases.id, released.body.id));
    expect(row).toMatchObject({
      classId: ids.classB,
      releasedBy: ids.marcus,
      releasedAt: at,
      recipients: [{ studentId: ids.priya, attemptId: attempt.priya, gradeId: priya.gradeId }],
    });
    const [event] = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'grade.released'), eq(auditEvents.targetId, row?.id ?? '')),
      );
    expect(event).toMatchObject({ actorId: ids.marcus, scopeId: ids.classB, createdAt: at });

    const seen = await results('priya');
    expect(seen.body.attempts[0]).toMatchObject({
      status: 'released',
      grade: {
        gradeId: priya.gradeId,
        points: 13,
        possible: 13,
        overridden: false,
        releasedAt: at.toISOString(),
        feedback: [
          { target: { kind: 'attempt' }, text: 'Draft note for priya' },
          {
            target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
            text: 'Hard-coded',
          },
        ],
      },
    });
    expect(seen.body.reported).toEqual({
      attemptId: attempt.priya,
      gradeId: priya.gradeId,
      points: 13,
      possible: 13,
    });
    expect((await results('sam')).body.attempts[0]).toMatchObject({
      status: 'pending',
      grade: null,
    });
    expect((await readGrade('priya')).body.attemptState).toBe('released');
  });

  test('A17 a release whose grade changed since the preview releases nothing', async () => {
    const preview = await call(w, 'marcus', 'POST', `${releaseUrl}/preview`, {
      attemptIds: [attempt.sam],
    });
    const previewed = preview.body.recipients[0].gradeId as string;
    tick();
    const newer = await saveDraft('sam', previewed, 'Revised note');
    expect(newer.status).toBe(200);
    const refused = await call(w, 'marcus', 'POST', releaseUrl, {
      grades: [{ attemptId: attempt.sam, gradeId: previewed }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('release_changed');
    expect(refused.body.preview.recipients[0].gradeId).toBe(newer.body.history[0].id);
    expect((await results('sam')).body.attempts[0].status).toBe('pending');
  });

  test('A17 a new draft after a release stays invisible until it is released', async () => {
    const current = (await readGrade('priya')).body.history[0];
    tick();
    const draft = await saveDraft('priya', current.id, 'Unreleased second thoughts');
    expect(draft.status).toBe(200);
    expect(draft.body.history.map((g: { state: string }) => g.state)).toEqual([
      'draft',
      'released',
    ]);
    expect(draft.body.released.id).toBe(current.id);
    const seen = await results('priya');
    expect(seen.body.attempts[0].grade.gradeId).toBe(current.id);
    expect(JSON.stringify(seen.body)).not.toContain('Unreleased');
  });

  test('A17 a grade row changes only by its release', async () => {
    const [row] = await w.testDb.db
      .select()
      .from(grades)
      .where(eq(grades.attemptId, attempt.sam as string));
    await expect(
      w.testDb.db.execute(sql`update grades set points = 0 where id = ${row?.id}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/rejected/) } });
    await expect(
      w.testDb.db.execute(sql`delete from grades where id = ${row?.id}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/rejected/) } });
  });
});

describe('A18 grading failure and overrides', () => {
  let prior: { id: string; points: number; complete: boolean };

  test('A18 a lost grading run leaves the attempt in NeedsReview, unreleasable, its student told nothing', async () => {
    const read = await readGrade('bea');
    expect(read.body.attemptState).toBe('needs_review');
    const mean = read.body.automated.find((q: { questionId: string }) => q.questionId === 'mean');
    expect(mean.automated).toMatchObject({ status: 'unavailable', points: null });

    tick();
    const draft = await saveDraft('bea', null, 'Waiting on the replay');
    expect(draft.status).toBe(200);
    prior = draft.body.history[0];
    expect(prior).toMatchObject({ complete: false, points: 9 });
    expect(draft.body.attemptState).toBe('needs_review');

    const preview = await call(w, 'marcus', 'POST', `${releaseUrl}/preview`, {
      attemptIds: [attempt.bea],
    });
    expect(preview.body).toEqual({
      recipients: [],
      skipped: [{ attemptId: attempt.bea, reason: 'incomplete' }],
    });
    expect((await results('bea')).body.attempts[0]).toMatchObject({
      status: 'pending',
      grade: null,
    });
  });

  test('A18 a manual grade override retains the prior result and its reason', async () => {
    const at = tick();
    const res = await call(w, 'marcus', 'POST', `${gradeUrl('bea')}/override`, {
      expectedGradeId: prior.id,
      points: 12,
      reason: 'Runner image missing; code checked by hand',
    });
    expect(res.status).toBe(200);
    const [current, kept] = res.body.history;
    expect(current).toMatchObject({
      number: 2,
      source: 'override',
      reason: 'Runner image missing; code checked by hand',
      points: 12,
      complete: true,
      automatedPoints: 9,
      override: { points: 12, priorGradeId: prior.id, createdBy: ids.marcus },
    });
    // The prior result is the same row, unchanged.
    expect(kept).toEqual(prior);
    expect(res.body.attemptState).toBe('graded');

    const [stored] = await w.testDb.db
      .select()
      .from(gradeOverrides)
      .where(eq(gradeOverrides.attemptId, attempt.bea as string));
    expect(stored).toMatchObject({
      priorGradeId: prior.id,
      points: 12,
      reason: 'Runner image missing; code checked by hand',
      createdBy: ids.marcus,
      createdAt: at,
    });
    const [event] = await w.testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'grade.overridden'), eq(auditEvents.targetId, current.id)));
    expect(event?.after).toMatchObject({ reason: 'Runner image missing; code checked by hand' });

    const released = await call(w, 'marcus', 'POST', releaseUrl, {
      grades: [{ attemptId: attempt.bea, gradeId: current.id }],
    });
    expect(released.status).toBe(201);
    const seen = await results('bea');
    expect(seen.body.attempts[0].grade).toMatchObject({ points: 12, overridden: true });
    expect(JSON.stringify(seen.body)).not.toContain('Runner image missing');
  });

  test('A18 a regrade after a replay creates a new grade row with its reason', async () => {
    const replay = await call(
      w,
      'marcus',
      'POST',
      `${attemptUrl(ids.classB, attempt.bea as string)}/questions/mean/replays`,
      {
        reason: 'replay',
        note: 'Image restored',
      },
    );
    expect(replay.status).toBe(202);
    await w.runner.finish(await w.runner.take());
    await drain(w);
    const before = (await readGrade('bea')).body.history[0];
    tick();
    const res = await call(w, 'marcus', 'POST', `${gradeUrl('bea')}/regrade`, {
      expectedGradeId: before.id,
      reason: 'Replayed after the runner outage',
    });
    expect(res.status).toBe(200);
    const [regraded] = res.body.history;
    expect(regraded).toMatchObject({
      number: 3,
      source: 'regrade',
      reason: 'Replayed after the runner outage',
      automatedPoints: 13,
      // The override stays in force; the automated result is now distinguishable from it.
      points: 12,
      override: { id: before.override.id },
      state: 'draft',
    });
    const mean = regraded.questions.find((q: { questionId: string }) => q.questionId === 'mean');
    expect(mean.automated).toMatchObject({ status: 'scored', points: 4 });
    expect(mean.automated.resultId).not.toBeNull();
    expect(res.body.history).toHaveLength(3);
    // Bea still sees the released override, not the regrade draft.
    expect((await results('bea')).body.attempts[0].grade.gradeId).toBe(before.id);
  });

  test('A18 the reported grade follows the assignment rule over released grades', async () => {
    const list = await call(
      w,
      'marcus',
      'GET',
      `/api/classes/${ids.classB}/resources/${w.quizId}/grades`,
    );
    expect(list.status).toBe(200);
    expect(list.body.rule).toBe('latest');
    const byName = new Map(
      list.body.students.map((s: { student: { name: string } }) => [s.student.name, s]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
    const bea = byName.get('Bea Lindqvist') as any;
    expect(bea.reported).toMatchObject({ attemptId: attempt.bea, points: 12 });
    expect(bea.attempts[0]).toMatchObject({ current: { number: 3 }, released: { number: 2 } });
    // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
    expect((byName.get('Sam Okafor') as any).reported).toBeNull();

    const selected = await put(
      'marcus',
      `/api/classes/${ids.classB}/resources/${w.quizId}/grades/selection`,
      { studentId: ids.sam, attemptId: attempt.sam },
    );
    expect(selected.status).toBe(200);
    const [row] = await w.testDb.db
      .select({ reportSelected: testAttempts.reportSelected })
      .from(testAttempts)
      .where(eq(testAttempts.id, attempt.sam as string));
    expect(row?.reportSelected).toBe(true);
  });
});
