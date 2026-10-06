import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PersonName } from '../fixtures/world';
import { ids } from '../fixtures/world';
import { attemptUrl, call, drain, type ExecWorld, execWorld, startAttempt } from './execution';

/**
 * A20 (feedback part): a student finds released feedback and sees exactly what the attempt's
 * release policy allows. Class B: Marcus teaches Priya, whose attempt started under the default
 * policy (solutions never, hidden test details off), and Sam, whose attempt started after
 * Marcus released both.
 */

let w: ExecWorld;
const attempt: Partial<Record<PersonName, string>> = {};
const CODE = 'def f(xs):\n    return 2\n';
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 60_000);
  return w.clock.now;
};
const detail = (who: PersonName, of: PersonName = who) =>
  call(w, who, 'GET', `${attemptUrl(ids.classB, attempt[of] as string)}/released`);

async function put(who: PersonName, url: string, payload: object) {
  const res = await w.app.inject({
    method: 'PUT',
    url,
    headers: { host: '127.0.0.1:3100', cookie: w.world.cookie[who] },
    payload,
  });
  return res.statusCode;
}

async function takeTest(who: PersonName) {
  tick();
  const id = await startAttempt(w, who, ids.classB);
  attempt[who] = id;
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
    submissionKey: `a20-submit-${who}`,
  });
  expect(done.status).toBe(200);
  for (let i = 0; i < 3; i++) await w.runner.finish(await w.runner.take());
  await drain(w);
}

async function release(who: PersonName) {
  const grade = await call(
    w,
    'marcus',
    'POST',
    `${attemptUrl(ids.classB, attempt[who] as string)}/grade`,
    {
      expectedGradeId: null,
      manual: [],
      feedback: [
        { target: { kind: 'attempt' }, text: `Well done ${who}` },
        {
          target: { kind: 'line', questionId: 'mean', path: 'solution.py', line: 2 },
          text: 'Hard-coded',
        },
      ],
    },
  );
  expect(grade.status).toBe(200);
  const released = await call(w, 'marcus', 'POST', `/api/classes/${ids.classB}/grade-releases`, {
    grades: [{ attemptId: attempt[who], gradeId: grade.body.history[0].id }],
  });
  expect(released.status).toBe(201);
}

beforeAll(async () => {
  w = await execWorld();
  await takeTest('priya');
  expect(
    await put('marcus', `/api/classes/${ids.classB}/resources/${w.quizId}/assignment`, {
      settings: {
        release: {
          results: 'manual',
          at: null,
          solutions: 'with_results',
          hiddenTestDetails: true,
        },
      },
      expectedRevision: null,
    }),
  ).toBe(200);
  await takeTest('sam');
});
afterAll(async () => {
  await w?.close();
});

describe('A20 released feedback in detail', () => {
  test('A20 an attempt without a released grade is not found, its status stays pending', async () => {
    expect((await detail('priya')).status).toBe(404);
    const list = await call(
      w,
      'priya',
      'GET',
      `/api/classes/${ids.classB}/resources/${w.quizId}/results`,
    );
    expect(list.body.attempts[0]).toMatchObject({
      status: 'pending',
      state: 'submitted',
      grade: null,
    });
  });

  test('A20 under the default policy a student sees their answers and public checks, no solution or hidden check', async () => {
    tick();
    await release('priya');
    const res = await detail('priya');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ solutionsShown: false, hiddenTestDetailsShown: false });
    const [mean, , , pick] = res.body.questions;
    expect(mean).toMatchObject({
      questionId: 'mean',
      kind: 'code',
      solution: null,
      code: {
        files: [{ path: 'solution.py', content: CODE }],
        checks: [{ name: 'sample', status: 'passed', visibility: 'public' }],
        checkTotals: { passed: 1, total: 1 },
      },
    });
    expect(mean.code.checks).toHaveLength(1);
    expect(pick).toMatchObject({ answer: ['b'], solution: null });
    expect(JSON.stringify(res.body)).not.toContain('hidden-large');
    expect(JSON.stringify(res.body)).not.toContain('large.txt');
  });

  test('A20 a released attempt under a permissive policy shows the answer key and hidden checks', async () => {
    tick();
    await release('sam');
    const res = await detail('sam');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ solutionsShown: true, hiddenTestDetailsShown: true });
    const [mean, , , pick] = res.body.questions;
    expect(mean.code.checks.map((c: { name: string }) => c.name)).toEqual([
      'sample',
      'hidden-large',
    ]);
    expect(mean.code.checks[1]).toMatchObject({ visibility: 'hidden', status: 'passed' });
    expect(mean.code.checkTotals).toEqual({ passed: 2, total: 2 });
    expect(pick.solution).toEqual({ correct: ['b'] });
  });

  test("A20 a student cannot read another student's attempt detail", async () => {
    expect((await detail('sam', 'priya')).status).toBe(404);
    expect((await detail('bea', 'sam')).status).toBe(404);
  });
});
