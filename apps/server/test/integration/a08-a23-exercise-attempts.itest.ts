import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/content/adoption';
import { createResource } from '../../src/content/drafts';
import { publishRelease } from '../../src/content/releases';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

/** The reference exercise of §9: Predict → Inspect → Explain. */
const sampleSize = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'If n grows from 25 to 100, how does the spread of sample means change?',
      options: [
        { id: 'wider', label: 'Wider', feedback: 'Larger samples average out more noise.' },
        { id: 'same', label: 'About the same' },
        { id: 'narrower', label: 'Narrower' },
      ],
      correct: 'narrower',
      shuffle: true,
      hints: ['Think about what averaging does to noise.', 'The SE is σ/√n.'],
      solution: 'Narrower: quadrupling n halves the standard error.',
      feedback: { correct: 'Yes: the spread narrows.', incorrect: 'Not quite.' },
    },
    {
      id: 'inspect',
      kind: 'simulation',
      title: 'Inspect',
      prompt: 'Compare n = 100 with the baseline n = 25.',
      control: { name: 'n', label: 'Sample size', min: 5, max: 200, step: 5, initial: 25 },
      observations: [{ id: 'sd', label: 'SD of sample means' }],
      compare: [25, 100],
      solution: 'At n = 100 the SD of sample means is half that at n = 25.',
      feedback: { correct: 'Both compared.', incomplete: 'Now compare with n = 100.' },
    },
    {
      id: 'explain',
      kind: 'text',
      title: 'Explain',
      prompt: 'Explain the result in your own words.',
      solution: 'Averages of more values vary less.',
      feedback: { saved: 'Saved. Your practice is complete.' },
    },
  ],
};

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let exerciseId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  const course = asCourseScope(ids.statistics, ids.elena);
  const created = await createResource(
    testDb.db,
    course,
    ids.sampling,
    { type: 'exercise', title: 'Sample size and spread', content: sampleSize },
    now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  exerciseId = created.value.id;
  const v2 = await publishRelease(testDb.db, course);
  if (!v2.ok) throw new Error(JSON.stringify(v2.report));
  for (const [classId, instructor] of [
    [ids.classA, ids.priya],
    [ids.classB, ids.marcus],
  ] as const) {
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(classId, ids.statistics, instructor, { releaseId: ids.releaseV1 }),
      { releaseId: v2.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
  }
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => now,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function call(who: PersonName, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

const open = async (who: PersonName, classId: string) => {
  const res = await call(
    who,
    'POST',
    `/api/classes/${classId}/resources/${exerciseId}/exercise-attempt`,
  );
  expect(res.status).toBe(200);
  return res.body;
};
const act = (who: PersonName, classId: string, attemptId: string, action: string, body?: object) =>
  call(who, 'POST', `/api/classes/${classId}/exercise-attempts/${attemptId}/${action}`, body ?? {});
const review = async (who: PersonName, classId: string) => {
  const res = await call(
    who,
    'GET',
    `/api/classes/${classId}/resources/${exerciseId}/exercise-attempts`,
  );
  expect(res.status).toBe(200);
  return res.body.attempts;
};

describe('exercise attempts', () => {
  test('A08 a wrong answer gets specific feedback, keeps the response, and allows retry', async () => {
    const attempt = await open('sam', ids.classA);
    expect(attempt.number).toBe(1);
    const predict = attempt.steps[0];
    expect(predict.options.map((o: { id: string }) => o.id).sort()).toEqual([
      'narrower',
      'same',
      'wider',
    ]);
    // The answer key, feedback, hints and solution never reach the student before use.
    const raw = JSON.stringify(attempt);
    for (const secret of ['"correct"', 'Larger samples', 'σ/√n', 'quadrupling']) {
      expect(raw).not.toContain(secret);
    }

    const wrong = await act('sam', ids.classA, attempt.id, 'check', {
      stepId: 'predict',
      response: 'wider',
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.result).toEqual({
      correct: false,
      feedback: 'Larger samples average out more noise.',
    });
    expect(wrong.body.attempt.steps[0]).toMatchObject({
      status: 'pending',
      response: 'wider',
      feedback: 'Larger samples average out more noise.',
      checks: 1,
    });
    // The reopened attempt still shows the learner's work.
    expect((await open('sam', ids.classA)).steps[0].response).toBe('wider');

    const right = await act('sam', ids.classA, attempt.id, 'check', {
      stepId: 'predict',
      response: 'narrower',
    });
    expect(right.body.result.correct).toBe(true);
    expect(right.body.attempt.steps[0]).toMatchObject({ status: 'completed', help: 'independent' });
  });

  test('A08 malformed or out-of-order responses are refused and not recorded', async () => {
    const attempt = await open('sam', ids.classA);
    const before = attempt.steps[1].checks;
    const bad = [
      { stepId: 'inspect', response: { value: 102 } },
      { stepId: 'inspect', response: { value: 100, observations: { pointer: 4 } } },
      { stepId: 'inspect', response: 'n = 100' },
      { stepId: 'explain', response: 'skipping ahead' },
      { stepId: 'nope', response: 1 },
    ];
    for (const body of bad) {
      expect((await act('sam', ids.classA, attempt.id, 'check', body)).status).toBe(400);
    }
    expect((await open('sam', ids.classA)).steps[1].checks).toBe(before);
    // Another student cannot act on Sam's attempt; another class cannot see it.
    expect((await act('bea', ids.classB, attempt.id, 'hint', { stepId: 'inspect' })).status).toBe(
      404,
    );
    expect((await act('priya', ids.classB, attempt.id, 'hint', { stepId: 'inspect' })).status).toBe(
      404,
    );
  });

  test('A08 a simulation completes after comparing the declared values', async () => {
    const attempt = await open('sam', ids.classA);
    const first = await act('sam', ids.classA, attempt.id, 'check', {
      stepId: 'inspect',
      response: { value: 25, observations: { sd: 2 } },
    });
    expect(first.body.result).toEqual({ correct: false, feedback: 'Now compare with n = 100.' });
    const second = await act('sam', ids.classA, attempt.id, 'check', {
      stepId: 'inspect',
      response: { value: 100, observations: { sd: 1 } },
    });
    expect(second.body.result).toEqual({ correct: true, feedback: 'Both compared.' });
    expect(second.body.attempt.steps[1]).toMatchObject({
      status: 'completed',
      help: 'independent',
      compared: [25, 100],
    });
  });

  test('A23 empty explanation text cannot complete the final step', async () => {
    const attempt = await open('sam', ids.classA);
    for (const response of ['', '   \n\t ']) {
      const res = await act('sam', ids.classA, attempt.id, 'complete', {
        stepId: 'explain',
        response,
      });
      expect(res.status).toBe(400);
    }
    // Revealing the model answer does not save an explanation either.
    const solved = await act('sam', ids.classA, attempt.id, 'solution', { stepId: 'explain' });
    expect(solved.body.steps[2]).toMatchObject({
      status: 'pending',
      solution: 'Averages of more values vary less.',
    });
    expect(solved.body.completion).toBeNull();

    const done = await act('sam', ids.classA, attempt.id, 'complete', {
      stepId: 'explain',
      response: 'Averages of more values vary less.',
    });
    expect(done.status).toBe(200);
    expect(done.body.steps[2]).toMatchObject({
      status: 'completed',
      help: 'solution_shown',
      feedback: 'Saved. Your practice is complete.',
    });
    expect(done.body).toMatchObject({
      completion: 'solution_shown',
      completedAt: now.toISOString(),
    });
  });

  test('A08 hint and solution use appear distinctly in instructor review', async () => {
    const attempt = await open('bea', ids.classB);
    const hint = await act('bea', ids.classB, attempt.id, 'hint', { stepId: 'predict' });
    expect(hint.body.steps[0].hints).toEqual(['Think about what averaging does to noise.']);
    await act('bea', ids.classB, attempt.id, 'check', { stepId: 'predict', response: 'same' });
    await act('bea', ids.classB, attempt.id, 'check', { stepId: 'predict', response: 'narrower' });
    const shown = await act('bea', ids.classB, attempt.id, 'solution', { stepId: 'inspect' });
    expect(shown.body.steps[1]).toMatchObject({ status: 'completed', help: 'solution_shown' });
    const done = await act('bea', ids.classB, attempt.id, 'complete', {
      stepId: 'explain',
      response: 'More values per mean, less spread.',
    });
    expect(done.body.completion).toBe('solution_shown');

    const [bea, ...others] = await review('marcus', ids.classB);
    expect(others).toEqual([]);
    expect(bea).toMatchObject({
      student: { id: ids.bea, name: 'Bea Lindqvist' },
      number: 1,
      completion: 'solution_shown',
      restarted: false,
    });
    expect(bea.steps).toEqual([
      expect.objectContaining({
        id: 'predict',
        help: 'with_hints',
        hintsShown: 1,
        solutionShown: false,
        checks: [
          expect.objectContaining({ response: 'same', correct: false }),
          expect.objectContaining({ response: 'narrower', correct: true }),
        ],
      }),
      expect.objectContaining({ id: 'inspect', help: 'solution_shown', solutionShown: true }),
      expect.objectContaining({
        id: 'explain',
        help: 'independent',
        finalResponse: 'More values per mean, less spread.',
      }),
    ]);

    // Class A's review holds Sam's attempt only: cohorts stay apart.
    const classA = await review('priya', ids.classA);
    expect(classA.map((a: { student: { id: string } }) => a.student.id)).toEqual([ids.sam]);
    expect(
      (
        await call(
          'sam',
          'GET',
          `/api/classes/${ids.classA}/resources/${exerciseId}/exercise-attempts`,
        )
      ).status,
    ).toBe(403);
  });

  test('A23 starting again keeps the prior attempt’s help record', async () => {
    const first = await open('bea', ids.classB);
    const restarted = await act('bea', ids.classB, first.id, 'restart');
    expect(restarted.status).toBe(200);
    expect(restarted.body).toMatchObject({ number: 2, completion: null });
    expect(restarted.body.id).not.toBe(first.id);
    expect(restarted.body.steps.map((s: { hints: string[] }) => s.hints)).toEqual([[], [], []]);

    // The old attempt accepts nothing more; a stale tab gets the current attempt.
    const stale = await act('bea', ids.classB, first.id, 'hint', { stepId: 'predict' });
    expect(stale.status).toBe(409);
    expect(stale.body.current.id).toBe(restarted.body.id);
    expect((await act('bea', ids.classB, first.id, 'restart')).status).toBe(409);

    const attempts = await review('marcus', ids.classB);
    expect(attempts.map((a: { number: number }) => a.number)).toEqual([2, 1]);
    expect(attempts[1]).toMatchObject({
      id: first.id,
      restarted: true,
      completion: 'solution_shown',
    });
    expect(attempts[1].steps[0]).toMatchObject({ hintsShown: 1, help: 'with_hints' });
    expect(attempts[1].steps[1]).toMatchObject({ solutionShown: true });
  });

  test('A23 recorded events cannot be updated or deleted', async () => {
    await expect(
      testDb.db.execute(sql`update exercise_events set payload = '{}'::jsonb`),
    ).rejects.toThrow();
    await expect(
      testDb.db.execute(sql`delete from exercise_events where kind = 'hint_shown'`),
    ).rejects.toThrow();
    const [count] = (
      await testDb.db.execute(
        sql`select count(*)::int as n from exercise_events where kind = 'hint_shown'`,
      )
    ).rows as { n: number }[];
    expect(count?.n).toBeGreaterThan(0);
  });

  test('A08 preview attempts stay out of review; drafts must be valid exercise.v1', async () => {
    const preview = await open('previewB', ids.classB);
    await act('previewB', ids.classB, preview.id, 'hint', { stepId: 'predict' });
    const students = (await review('marcus', ids.classB)).map(
      (a: { student: { id: string } }) => a.student.id,
    );
    expect(students).not.toContain(ids.previewB);
    // Removing an attempt (retention, account deletion) still cascades to its events.
    await testDb.db.execute(sql`delete from exercise_attempts where user_id = ${ids.previewB}`);

    const invalid = await call(
      'elena',
      'POST',
      `/api/courses/${ids.statistics}/topics/${ids.sampling}/resources`,
      {
        type: 'exercise',
        title: 'Broken',
        content: { schema: 'exercise.v1', steps: [{ ...sampleSize.steps[0], correct: 'maybe' }] },
      },
    );
    expect(invalid.status).toBe(400);
    // A non-exercise resource is not an exercise.
    const reading = await call(
      'sam',
      'POST',
      `/api/classes/${ids.classA}/resources/${ids.samplingReading}/exercise-attempt`,
    );
    expect(reading.status).toBe(404);
  });
});
