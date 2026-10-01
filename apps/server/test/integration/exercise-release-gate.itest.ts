import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/content/adoption';
import { createResource } from '../../src/content/drafts';
import { publishRelease } from '../../src/content/releases';
import { resources } from '../../src/db/schema';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const start = new Date('2026-10-01T09:00:00Z');
const releaseAt = new Date('2026-10-08T09:00:00Z');
let clock = start;

const definition = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'Does the spread of sample means grow with n?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      correct: 'no',
      hints: ['Think about averaging.'],
      solution: 'No: it narrows.',
      feedback: { correct: 'Yes, it narrows.', incorrect: 'Not quite.' },
    },
    {
      id: 'explain',
      kind: 'text',
      title: 'Explain',
      prompt: 'Explain.',
      feedback: { saved: 'Saved.' },
    },
  ],
};

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let exerciseId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  const created = await createResource(
    testDb.db,
    asCourseScope(ids.statistics, ids.elena),
    ids.sampling,
    { type: 'exercise', title: 'Spread of sample means', content: definition },
    start,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  exerciseId = created.value.id;
  await moveClassB(null, ids.releaseV1);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => clock,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

/** Publishes the drafts with the exercise scheduled for `at` and moves class B onto them. */
async function moveClassB(at: Date | null, from: string) {
  await testDb.db.update(resources).set({ releaseAt: at }).where(eq(resources.id, exerciseId));
  const published = await publishRelease(testDb.db, asCourseScope(ids.statistics, ids.elena));
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  const adopted = await adoptRelease(
    testDb.db,
    asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: from }),
    { releaseId: published.release.id, expectedReleaseId: from },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
  return published.release.id;
}

async function call(who: PersonName, url: string, payload: object = {}) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: world.cookie[who] },
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

const base = `/api/classes/${ids.classB}`;
const open = (who: PersonName) => call(who, `${base}/resources/${exerciseId}/exercise-attempt`);
const act = (who: PersonName, attemptId: string, action: string, body: object) =>
  call(who, `${base}/exercise-attempts/${attemptId}/${action}`, body);

describe('an exercise scheduled for later', () => {
  test('a student can neither open nor act on an exercise before its release time', async () => {
    // Bea started practising while the exercise was open to her.
    const attempt = await open('bea');
    expect(attempt.status).toBe(200);
    await moveClassB(releaseAt, (await classRelease()) ?? ids.releaseV1);

    expect((await open('bea')).status).toBe(404);
    const blocked = [
      ['check', { stepId: 'predict', response: 'no' }],
      ['hint', { stepId: 'predict' }],
      ['solution', { stepId: 'predict' }],
      ['complete', { stepId: 'explain', response: 'early' }],
      ['restart', {}],
    ] as const;
    for (const [action, body] of blocked) {
      expect((await act('bea', attempt.body.id, action, body)).status).toBe(404);
    }

    // The instructor prepares the exercise before it opens.
    expect((await open('marcus')).status).toBe(200);

    // At its release time it opens to students, with the work they had already recorded.
    clock = releaseAt;
    const opened = await open('bea');
    expect(opened.status).toBe(200);
    expect(opened.body.id).toBe(attempt.body.id);
    const checked = await act('bea', attempt.body.id, 'check', {
      stepId: 'predict',
      response: 'no',
    });
    expect(checked.status).toBe(200);
    expect(checked.body.result.correct).toBe(true);
  });
});

async function classRelease(): Promise<string | undefined> {
  const res = await app.inject({
    method: 'GET',
    url: `${base}/release`,
    headers: { cookie: world.cookie.marcus },
  });
  return res.json().release?.id;
}
