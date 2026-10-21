import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
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
const feedback = { correct: 'Right.', incorrect: 'Not yet.' };

/** One step of each family of interactive kinds (§9, amended 21 October 2026). */
const interactive = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'sort',
      kind: 'categorize',
      title: 'Sort',
      prompt: 'Sort the variables.',
      categories: [
        { id: 'counted', label: 'Counted' },
        { id: 'measured', label: 'Measured' },
      ],
      items: [
        { id: 'goals', label: 'Goals', category: 'counted' },
        { id: 'height', label: 'Height', category: 'measured', feedback: 'Height is measured.' },
      ],
      marks: true,
      feedback,
    },
    {
      id: 'plot',
      kind: 'plot_points',
      title: 'Plot',
      prompt: 'Plot the centre of the points.',
      scene: { x: [0, 8], y: [0, 8], grid: 1 },
      points: [{ id: 'c', label: 'Centre', answer: [3, 4] }],
      snap: 0.5,
      solution: 'The centre is (3, 4).',
      feedback,
    },
    {
      id: 'slope',
      kind: 'manipulate',
      title: 'Slope',
      prompt: 'Drag P until the slope is 2.',
      params: [
        {
          kind: 'point',
          name: 'P',
          label: 'P',
          x: [-4, 4],
          y: [-4, 4],
          step: 0.5,
          initial: [2, 1],
        },
      ],
      scene: {
        x: [-4, 4],
        y: [-4, 4],
        shapes: [
          {
            type: 'line',
            through: [
              [0, 0],
              ['P.x', 'P.y'],
            ],
          },
        ],
      },
      target: ['P.x != 0', 'near(P.y, 2 * P.x, 0.01)'],
      answer: { P: [1, 2] },
      feedback: { ...feedback, rules: [{ when: 'P.y < 2 * P.x', say: 'Too shallow.' }] },
    },
    {
      id: 'watch',
      kind: 'explore',
      title: 'Watch',
      prompt: 'Press Play.',
      params: [
        { name: 'n', label: 'n', min: 1, max: 25, step: 1, initial: 1, animate: { seconds: 8 } },
      ],
      scene: { x: [-3, 3], y: [0, 2], shapes: [{ type: 'function', y: 'exp(-(x^2) * n / 2)' }] },
    },
    {
      id: 'sketch',
      kind: 'drawing',
      title: 'Sketch',
      prompt: 'Draw a scatter plot with a negative correlation.',
      feedback: { saved: 'Saved for your instructor.' },
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
    { type: 'exercise', title: 'Drag, draw and explore', content: interactive },
    now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  exerciseId = created.value.id;
  const v2 = await publishRelease(testDb.db, course, { runtimes: DEV_RUNNER_RUNTIMES });
  if (!v2.ok) throw new Error(JSON.stringify(v2.report));
  const adopted = await adoptRelease(
    testDb.db,
    asClassScope(ids.classA, ids.statistics, ids.priya, { releaseId: ids.releaseV1 }),
    { releaseId: v2.release.id, expectedReleaseId: ids.releaseV1 },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
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
const open = async (who: PersonName) => {
  const res = await call(
    who,
    'POST',
    `/api/classes/${ids.classA}/resources/${exerciseId}/exercise-attempt`,
  );
  expect(res.status).toBe(200);
  return res.body;
};
const act = (who: PersonName, attemptId: string, action: string, body?: object) =>
  call(who, 'POST', `/api/classes/${ids.classA}/exercise-attempts/${attemptId}/${action}`, body);

describe('interactive exercise steps', () => {
  test('A08 a student sees each scene but no key, and a wrong sorting is marked part by part', async () => {
    const attempt = await open('sam');
    expect(attempt.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'categorize',
      'plot_points',
      'manipulate',
      'explore',
      'drawing',
    ]);
    expect(attempt.steps[1].interactive).toMatchObject({
      kind: 'plot_points',
      points: [{ id: 'c', label: 'Centre' }],
    });
    const raw = JSON.stringify(attempt);
    for (const secret of ['"category"', 'Height is measured', 'near(P.y', 'Too shallow', '[3,4]']) {
      expect(raw).not.toContain(secret);
    }

    const refused = await act('sam', attempt.id, 'check', {
      stepId: 'sort',
      response: { goals: 'counted', height: 'weighed' },
    });
    expect(refused.status).toBe(400);
    const wrong = await act('sam', attempt.id, 'check', {
      stepId: 'sort',
      response: { goals: 'counted', height: 'counted' },
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.result).toEqual({
      correct: false,
      feedback: 'Height is measured.',
      parts: { goals: true, height: false },
    });
    // The marks stay with the kept response when the attempt is opened again.
    expect((await open('sam')).steps[0]).toMatchObject({
      status: 'pending',
      response: { goals: 'counted', height: 'counted' },
      parts: { goals: true, height: false },
      checks: 1,
    });
    const right = await act('sam', attempt.id, 'check', {
      stepId: 'sort',
      response: { goals: 'counted', height: 'measured' },
    });
    expect(right.body.result).toEqual({
      correct: true,
      feedback: 'Right.',
      parts: { goals: true, height: true },
    });
  });

  test('A23 Show solution completes a plotted step and sends the answer to move into place', async () => {
    const attempt = await open('sam');
    // A position off the snap grid cannot be sent: it is not one a point can reach.
    const offGrid = await act('sam', attempt.id, 'check', {
      stepId: 'plot',
      response: { c: [3.2, 4] },
    });
    expect(offGrid.status).toBe(400);
    const shown = await act('sam', attempt.id, 'solution', { stepId: 'plot' });
    expect(shown.status).toBe(200);
    expect(shown.body.steps[1]).toMatchObject({
      status: 'completed',
      help: 'solution_shown',
      solution: 'The centre is (3, 4).',
      reveal: { c: [3, 4] },
    });
    // A step whose solution is not shown reveals nothing.
    expect(shown.body.steps[2].reveal).toBeUndefined();
  });

  test('A08 a manipulation is judged on the server, with the first rule that holds', async () => {
    const attempt = await open('sam');
    const shallow = await act('sam', attempt.id, 'check', {
      stepId: 'slope',
      response: { P: [2, 1] },
    });
    expect(shallow.body.result).toEqual({ correct: false, feedback: 'Too shallow.' });
    const outside = await act('sam', attempt.id, 'check', {
      stepId: 'slope',
      response: { P: [2, 4.25] },
    });
    expect(outside.status).toBe(400);
    const right = await act('sam', attempt.id, 'check', {
      stepId: 'slope',
      response: { P: [-1.5, -3] },
    });
    expect(right.body.result).toEqual({ correct: true, feedback: 'Right.' });
  });

  test('A07 an exploration and a drawing are saved, and review shows them with the step as seen', async () => {
    const attempt = await open('sam');
    const watched = await act('sam', attempt.id, 'complete', {
      stepId: 'watch',
      response: { n: 25 },
    });
    expect(watched.status).toBe(200);
    expect(watched.body.steps[3]).toMatchObject({ status: 'completed', help: 'independent' });
    // A drawing with neither strokes nor a description is not saved.
    const empty = await act('sam', attempt.id, 'complete', {
      stepId: 'sketch',
      response: { strokes: [], description: '  ' },
    });
    expect(empty.status).toBe(400);
    const stroke = {
      tool: 'pen',
      color: '#202124',
      width: 4,
      points: [
        [0.1, 0.9],
        [0.9, 0.1],
      ],
    };
    const drawing = { strokes: [stroke], description: 'Points falling from left to right.' };
    const saved = await act('sam', attempt.id, 'complete', { stepId: 'sketch', response: drawing });
    expect(saved.status).toBe(200);
    expect(saved.body.steps[4]).toMatchObject({
      status: 'completed',
      response: drawing,
      feedback: 'Saved for your instructor.',
    });
    expect(saved.body.completion).toBe('solution_shown');

    const res = await call(
      'priya',
      'GET',
      `/api/classes/${ids.classA}/resources/${exerciseId}/exercise-attempts`,
    );
    expect(res.status).toBe(200);
    const [sam] = res.body.attempts;
    expect(sam.steps[4]).toMatchObject({
      id: 'sketch',
      finalResponse: drawing,
      view: { kind: 'drawing', interactive: { kind: 'drawing', aspect: 1.6 } },
    });
    expect(sam.steps[0].checks.map((c: { correct: boolean }) => c.correct)).toEqual([false, true]);
  });

  test('A23 starting again keeps the shown solution and the marks of the first attempt, and the new one reveals nothing', async () => {
    const first = await open('sam');
    const restarted = await act('sam', first.id, 'restart');
    expect(restarted.status).toBe(200);
    expect(restarted.body).toMatchObject({ number: 2, completion: null });
    for (const s of restarted.body.steps) {
      expect(s).toMatchObject({ status: 'pending', help: null, checks: 0, response: null });
      expect(s.reveal).toBeUndefined();
      expect(s.parts).toBeUndefined();
    }
    // The first attempt keeps its record: the solution shown on the plot, the marked checks.
    const res = await call(
      'priya',
      'GET',
      `/api/classes/${ids.classA}/resources/${exerciseId}/exercise-attempts`,
    );
    const [second, earlier] = res.body.attempts;
    expect([second.number, earlier.number]).toEqual([2, 1]);
    expect(earlier).toMatchObject({ id: first.id, restarted: true, completion: 'solution_shown' });
    expect(earlier.steps[1]).toMatchObject({ id: 'plot', solutionShown: true });
    expect(earlier.steps[0].checks.map((c: { correct: boolean }) => c.correct)).toEqual([
      false,
      true,
    ]);
  });
});
