import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PersonName } from '../fixtures/world';
import { ids } from '../fixtures/world';
import { attemptUrl, call, drain, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * Class review (§12), A25: with Needs review active the filtered list holds exactly the
 * students whose results await release, preview principals never appear, and releasing the last
 * of them empties the list while every released grade stays in the unfiltered table. Class B:
 * Marcus teaches Bea (no work), Priya and Sam, who submit the test; Marcus's preview principal
 * also takes it.
 */

let w: ExecWorld;
const attempt: Partial<Record<PersonName, string>> = {};
const CODE = 'def f(xs):\n    return 2\n';
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 60_000);
  return w.clock.now;
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

const reviewUrl = (query = '') => `/api/classes/${ids.classB}/review${query}`;
const review = (query = '') => call(w, 'marcus', 'GET', reviewUrl(query));
const names = (list: { name: string }[]) => list.map((s) => s.name);

async function submit(who: PersonName) {
  tick();
  const id = await startAttempt(w, who, ids.classB);
  attempt[who] = id;
  if (who === 'previewB') return;
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
    submissionKey: `review-${who}`,
  });
  expect(done.status).toBe(200);
}

async function release(who: PersonName) {
  const url = `${attemptUrl(ids.classB, attempt[who] as string)}/grade`;
  const draft = await call(w, 'marcus', 'POST', url, {
    expectedGradeId: null,
    manual: [],
    feedback: [{ target: { kind: 'attempt' }, text: `Well done, ${who}` }],
  });
  expect(draft.status).toBe(200);
  const gradeId = draft.body.history[0].id as string;
  tick();
  const released = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/grade-releases`, {
    grades: [{ attemptId: attempt[who], gradeId }],
  });
  expect(released.status).toBe(201);
}

beforeAll(async () => {
  w = await execWorld();
  for (const who of ['priya', 'sam'] as const) await submit(who);
  for (let i = 0; i < 6; i++) await w.runner.finish(await w.runner.take());
  expect(await drain(w)).toEqual({ results: 6, deadLetters: 0 });
});
afterAll(async () => {
  await w?.close();
});

describe('A25 class review', () => {
  test('A25 the table lists real students with their test status, never a preview principal', async () => {
    const res = await review(`?assignmentId=${w.quizId}`);
    expect(res.status).toBe(200);
    expect(names(res.body.roster)).toEqual(['Bea Lindqvist', 'Priya Nair', 'Sam Okafor'].sort());
    expect(res.body.assignment).toMatchObject({ assignmentId: w.quizId, title: 'Spread check' });
    const byName = Object.fromEntries(
      res.body.rows.map((r: { name: string }) => [r.name.split(' ')[0], r]),
    );
    expect(byName.Bea).toMatchObject({ attempt: null, needsReview: false, lastSubmission: null });
    expect(byName.Priya.attempt).toMatchObject({ number: 1, score: null });
    expect(byName.Priya.attempt.state).not.toBe('in_progress');
    expect(byName.Priya).toMatchObject({ needsReview: true, lastSubmission: { kind: 'test' } });
    expect(JSON.stringify(res.body)).not.toContain(ids.previewB);
  });

  test('A25 with Needs review active previous/next stays in that filter', async () => {
    const res = await review('?needsReview=true');
    expect(names(res.body.students)).toEqual(['Priya Nair', 'Sam Okafor']);
    expect(res.body.total).toBe(2);
    // The traversed list is whole whatever page the table shows.
    const second = await review('?needsReview=true&pageSize=1&page=2');
    expect(names(second.body.rows)).toEqual(['Sam Okafor']);
    expect(names(second.body.students)).toEqual(['Priya Nair', 'Sam Okafor']);
    const one = await review(`?needsReview=true&studentId=${ids.sam}`);
    expect(names(one.body.students)).toEqual(['Sam Okafor']);
  });

  test('A25 the selected assignment and attempt stay visible in the response', async () => {
    const res = await review(`?needsReview=true&assignmentId=${w.quizId}&attemptId=${attempt.sam}`);
    expect(res.body.assignment.assignmentId).toBe(w.quizId);
    expect(res.body.selected).toEqual({
      studentId: ids.sam,
      studentName: 'Sam Okafor',
      attemptId: attempt.sam,
      number: 1,
      assignmentId: w.quizId,
    });
  });

  test('A25 each listed student carries their attempt at the selected assignment, whatever page the table shows', async () => {
    const res = await review(`?assignmentId=${w.quizId}&pageSize=1&page=3`);
    expect(res.body.students.map((x: { attempt: unknown }) => x.attempt)).toEqual([
      null,
      { attemptId: attempt.priya, number: 1 },
      { attemptId: attempt.sam, number: 1 },
    ]);
    expect(names(res.body.rows)).toEqual(['Sam Okafor']);
  });

  test('A25 a page past the end shows the last page', async () => {
    const res = await review('?needsReview=true&pageSize=1&page=9');
    expect(res.body).toMatchObject({ page: 2, total: 2 });
    expect(names(res.body.rows)).toEqual(['Sam Okafor']);
  });

  test('A25 an assignment outside the topic filter is no assignment, and exercises count every topic without one', async () => {
    const other = await review(`?assignmentId=${w.quizId}&topicId=${ids.estimation}`);
    expect(other.body.assignment).toBeNull();
    const all = await review(`?assignmentId=${w.quizId}`);
    expect(all.body.assignment).toMatchObject({ assignmentId: w.quizId });
    expect(all.body.topics.length).toBeGreaterThan(1);
  });

  test('A25 releasing the final result in Needs review empties the filter and retains every released grade', async () => {
    await release('priya');
    const afterFirst = await review('?needsReview=true');
    expect(names(afterFirst.body.students)).toEqual(['Sam Okafor']);

    await release('sam');
    const empty = await review('?needsReview=true');
    expect(empty.body).toMatchObject({ total: 0, rows: [], students: [] });

    const all = await review(`?assignmentId=${w.quizId}`);
    for (const row of all.body.rows.filter((r: { name: string }) => !r.name.startsWith('Bea'))) {
      expect(row.needsReview).toBe(false);
      expect(row.attempt).toMatchObject({
        state: 'released',
        score: { points: 13, possible: 13, state: 'released' },
      });
    }
    expect(all.body.total).toBe(3);
  });

  test('A25 a student of the class is refused the table', async () => {
    const res = await call(w, 'bea', 'GET', reviewUrl());
    expect(res.status).toBe(403);
    expect(res.body.rows).toBeUndefined();
  });
});

describe('A25 a change saved after release, and what a student shared', () => {
  const url = (who: PersonName) => `${attemptUrl(ids.classB, attempt[who] as string)}/grade`;

  test('A25 an override saved after release returns the student to Needs review until it is released', async () => {
    const before = await call(w, 'marcus', 'GET', url('priya'));
    expect(before.body.released).not.toBeNull();
    const saved = await call(w, 'marcus', 'POST', `${url('priya')}/override`, {
      expectedGradeId: before.body.history[0].id,
      points: 12,
      reason: 'Check misjudged a correct answer',
    });
    expect(saved.status).toBe(200);

    const waiting = await review(`?needsReview=true&assignmentId=${w.quizId}`);
    expect(names(waiting.body.students)).toEqual(['Priya Nair']);
    // The student still sees the released grade; the draft above it is the instructor's alone.
    expect(waiting.body.rows[0].attempt).toMatchObject({
      state: 'released',
      score: { points: 13, state: 'released' },
      unreleasedChange: true,
    });

    tick();
    const released = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/grade-releases`, {
      grades: [{ attemptId: attempt.priya, gradeId: saved.body.history[0].id }],
    });
    expect(released.status).toBe(201);
    const after = await review(`?needsReview=true&assignmentId=${w.quizId}`);
    expect(after.body.total).toBe(0);
    const row = (await review(`?assignmentId=${w.quizId}&studentId=${ids.priya}`)).body.rows[0];
    expect(row.attempt).toMatchObject({ score: { points: 12, state: 'released' } });
    expect(row.attempt.unreleasedChange).toBe(false);
  });

  const threadsUrl = (who: string) => `/api/classes/${ids.classB}/students/${who}/discussions`;
  const post = (who: PersonName, path: string, payload: object) =>
    call(
      w,
      who,
      'POST',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/${path}`,
      payload,
    );
  const passage = {
    kind: 'text',
    blockId: '0123456789ab',
    start: 6,
    end: 12,
    quote: 'sample',
    prefix: 'Every ',
    suffix: ' tells a slightly',
  };

  test('A25 the student view lists the questions and comments the student shared, with their source, and no private notes', async () => {
    expect(
      (
        await post('sam', 'threads', {
          audience: 'instructor',
          anchor: passage,
          body: 'Why n - 1?',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post('priya', 'threads', { audience: 'class', anchor: passage, body: 'Priya asks' }))
        .status,
    ).toBe(200);
    expect(
      (await post('sam', 'annotations', { kind: 'note', anchor: passage, body: 'my private note' }))
        .status,
    ).toBe(200);

    const sam = await call(w, 'marcus', 'GET', threadsUrl(ids.sam));
    expect(sam.status).toBe(200);
    expect(sam.body.discussions).toHaveLength(1);
    expect(sam.body.discussions[0]).toMatchObject({
      thread: { audience: 'instructor', author: { id: ids.sam }, status: 'open' },
      resource: { tab: 'reading', topicId: ids.sampling },
    });
    expect(sam.body.discussions[0].thread.posts[0].body).toBe('Why n - 1?');
    expect(JSON.stringify(sam.body)).not.toContain('my private note');
    expect(JSON.stringify(sam.body)).not.toContain('Priya asks');
  });

  test('A25 an id that is no student of the class is answered 404, not an empty list', async () => {
    // A co-instructor's threads are not "what a student shared", and a stranger is no one's student.
    expect((await call(w, 'marcus', 'GET', threadsUrl(ids.marcus))).status).toBe(404);
    expect((await call(w, 'marcus', 'GET', threadsUrl(ids.previewB))).status).toBe(404);
    expect(
      (await call(w, 'marcus', 'GET', threadsUrl('00000000-0000-4000-8000-0000000fffff'))).status,
    ).toBe(404);
  });

  test('A25 only an instructor of the class reads a student’s discussions', async () => {
    expect((await call(w, 'bea', 'GET', threadsUrl(ids.sam))).status).toBe(403);
    expect(
      (await call(w, 'marcus', 'GET', `/api/classes/${ids.classA}/students/${ids.sam}/discussions`))
        .status,
    ).toBe(404);
  });

  test('A25 a removed student’s open attempt and shared questions stay reachable', async () => {
    const removed = await w.app.inject({
      method: 'DELETE',
      url: `/api/classes/${ids.classB}/members/${ids.sam}`,
      headers: { host: '127.0.0.1:3100', cookie: w.world.cookie.elena },
    });
    expect(removed.statusCode).toBe(200);
    // Not in the table any more, but the open attempt still resolves, with the name.
    const res = await review(`?assignmentId=${w.quizId}&attemptId=${attempt.sam}`);
    expect(names(res.body.roster)).not.toContain('Sam Okafor');
    expect(res.body.selected).toMatchObject({
      studentId: ids.sam,
      studentName: 'Sam Okafor',
      attemptId: attempt.sam,
    });
    const shared = await call(w, 'marcus', 'GET', threadsUrl(ids.sam));
    expect(shared.status).toBe(200);
    expect(shared.body.discussions).toHaveLength(1);
    // A co-instructor's attempt id (never a student's) resolves to nothing.
    const none = await review(`?assignmentId=${w.quizId}&attemptId=${attempt.previewB}`);
    expect(none.body.selected).toBeNull();
  });
});
