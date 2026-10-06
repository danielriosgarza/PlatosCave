import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import type { ClassScope } from '../../src/auth/scope';
import { DEV_RUNNER_RUNTIMES, loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { studyableNotebook } from '../../src/db/notebooks/workingCopies';
import { topics } from '../../src/db/schema';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * A resource in a prerequisite-locked topic (§4) is unknown to the student on every
 * per-resource route, as the topic list, readings, slides and media already treat it:
 * annotations and threads, notifications, exercises, notebook submissions and Colab launches,
 * and the working-copy source. Instructors are unaffected.
 */

const now = new Date('2026-10-01T09:00:00Z');

const definition = {
  schema: 'exercise.v1',
  steps: [
    {
      id: 'predict',
      kind: 'single_choice',
      title: 'Predict',
      prompt: 'Does a confidence interval narrow with n?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      correct: 'yes',
      hints: ['Think about the standard error.'],
      solution: 'Yes: the standard error shrinks.',
      feedback: { correct: 'Right.', incorrect: 'Not quite.' },
    },
  ],
};

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let releaseId: string;
let inferenceId: string;
let exerciseId: string;
let notebookId: string;
let notebookRevisionId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  const { db } = testDb;
  const course = asCourseScope(ids.statistics, ids.elena);
  // Sampling completes once its material is marked reviewed, so a student can meet the
  // prerequisite (and undo it) through the review sheet.
  await db
    .update(topics)
    .set({ completionRule: { requires: ['reviewed:*'] } })
    .where(eq(topics.id, ids.sampling));
  const [inference] = await db
    .insert(topics)
    .values({
      courseId: ids.statistics,
      position: 2,
      title: 'Inference',
      prerequisites: [ids.sampling],
      createdBy: ids.elena,
    })
    .returning();
  if (!inference) throw new Error('no topic');
  inferenceId = inference.id;
  const exercise = await createResource(
    db,
    course,
    inferenceId,
    { type: 'exercise', title: 'Interval width', content: definition },
    now,
  );
  if (!exercise.ok) throw new Error(JSON.stringify(exercise));
  exerciseId = exercise.value.id;
  const notebook = await createResource(
    db,
    course,
    inferenceId,
    { type: 'notebook', title: 'Bootstrap intervals', content: {} },
    now,
  );
  if (!notebook.ok || !notebook.value.headRevisionId) throw new Error(JSON.stringify(notebook));
  notebookId = notebook.value.id;
  notebookRevisionId = notebook.value.headRevisionId;
  const published = await publishRelease(db, course, { runtimes: DEV_RUNNER_RUNTIMES });
  if (!published.ok) throw new Error(JSON.stringify(published.report));
  releaseId = published.release.id;
  const adopted = await adoptRelease(
    db,
    asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: ids.releaseV1 }),
    { releaseId, expectedReleaseId: ids.releaseV1 },
  );
  if (!adopted.ok) throw new Error(adopted.reason);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db,
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
  // biome-ignore lint/suspicious/noExplicitAny: assertions walk the response freely.
  return { status: res.statusCode, body: res.json() as any };
}

/** A notebook upload as the browser sends it: multipart with one `file` part. */
async function submit(who: PersonName, key: string) {
  const boundary = '----parallax-test-boundary';
  const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
  const res = await app.inject({
    method: 'POST',
    url: `${resource(notebookId)}/notebook-submissions?submissionKey=${key}`,
    headers: {
      cookie: world.cookie[who],
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="answer.ipynb"\r\nContent-Type: application/octet-stream\r\n\r\n${notebook}\r\n--${boundary}--\r\n`,
    ),
  });
  return res.statusCode;
}

const base = `/api/classes/${ids.classB}`;
const resource = (id: string) => `${base}/resources/${id}`;
const notFound = { status: 404, body: { error: 'not found' } };
const note = { kind: 'note', anchor: { kind: 'none' }, body: 'Why does it narrow?' };
const question = (body: string) => ({ audience: 'class', anchor: { kind: 'none' }, body });
const notified = async (who: PersonName) => {
  const res = await call(who, 'GET', `${base}/notifications`);
  expect(res.status).toBe(200);
  return (res.body.items as { threadId: string; resourceId: string }[]).map((i) => i.threadId);
};
const inferenceState = async (who: PersonName) => {
  const res = await call(who, 'GET', `${base}/topics`);
  return res.body.topics.find((t: { topicId: string }) => t.topicId === inferenceId)?.state;
};
/** Bea marks Sampling's reading reviewed (meeting Inference's prerequisite) or clears it. */
const review = async (reviewed: boolean) => {
  const res = await call(
    'bea',
    'PUT',
    `${base}/topics/${ids.sampling}/reviews/${ids.samplingReading}`,
    { reviewed },
  );
  expect(res.status).toBe(200);
  expect(res.body.complete).toBe(reviewed);
};
const beaScope = () =>
  ({
    ...asClassScope(ids.classB, ids.statistics, ids.bea, { role: 'student', releaseId }),
    membership: { id: ids.bea, role: 'student', manageMembers: false, isPreview: false },
  }) as unknown as ClassScope;

let threadId: string;
let annotationId: string;
let attemptId: string;

describe('a resource in a prerequisite-locked topic', () => {
  test('A05 a student cannot read or write the discussion of a locked topic, nor be notified of it', async () => {
    expect(await inferenceState('bea')).toBe('locked');
    // The instructor opens a class discussion on the exercise before anyone may study it.
    const posted = await call('marcus', 'POST', `${resource(exerciseId)}/threads`, {
      ...question('Bring a calculator.'),
    });
    expect(posted.status).toBe(200);
    threadId = posted.body.id;

    expect(await call('bea', 'GET', `${resource(exerciseId)}/annotations`)).toEqual(notFound);
    expect(await call('bea', 'POST', `${resource(exerciseId)}/annotations`, note)).toEqual(
      notFound,
    );
    expect(
      await call('bea', 'POST', `${resource(exerciseId)}/threads`, question('Early?')),
    ).toEqual(notFound);
    expect(
      (await call('bea', 'POST', `${base}/threads/${threadId}/posts`, { body: 'Which one?' }))
        .status,
    ).toBe(404);
    expect(await notified('bea')).not.toContain(threadId);

    // The instructor's view of the same resource is unchanged.
    const read = await call('marcus', 'GET', `${resource(exerciseId)}/annotations`);
    expect(read.status).toBe(200);
    expect(read.body.threads.map((t: { id: string }) => t.id)).toEqual([threadId]);
  });

  test('A08 a student can neither read nor start an exercise in a locked topic', async () => {
    expect(await call('bea', 'GET', `${resource(exerciseId)}/exercise`)).toEqual(notFound);
    expect(await call('bea', 'POST', `${resource(exerciseId)}/exercise-attempt`)).toEqual(notFound);
    expect((await call('marcus', 'GET', `${resource(exerciseId)}/exercise`)).status).toBe(200);
    expect((await call('marcus', 'POST', `${resource(exerciseId)}/exercise-attempt`)).status).toBe(
      200,
    );
  });

  test('A10 a student can neither submit nor launch a notebook of a locked topic', async () => {
    expect(await call('bea', 'POST', `${resource(notebookId)}/colab-launch`)).toEqual(notFound);
    expect(await submit('bea', '00000000-0000-4000-8000-0000000000a1')).toBe(404);
    // Nor copy it into a working copy through the notebook connection.
    expect(await studyableNotebook(testDb.db, beaScope(), notebookRevisionId, now)).toBeNull();
  });

  test('A05 A08 A10 once the prerequisite is met the same routes answer the student', async () => {
    await review(true);
    expect(await inferenceState('bea')).toBe('available');

    const read = await call('bea', 'GET', `${resource(exerciseId)}/annotations`);
    expect(read.status).toBe(200);
    expect(read.body.threads.map((t: { id: string }) => t.id)).toEqual([threadId]);
    expect(await notified('bea')).toContain(threadId);
    const mine = await call('bea', 'POST', `${resource(exerciseId)}/annotations`, note);
    expect(mine.status).toBe(200);
    annotationId = mine.body.id;

    expect((await call('bea', 'GET', `${resource(exerciseId)}/exercise`)).status).toBe(200);
    const attempt = await call('bea', 'POST', `${resource(exerciseId)}/exercise-attempt`);
    expect(attempt.status).toBe(200);
    attemptId = attempt.body.id;

    expect((await call('bea', 'POST', `${resource(notebookId)}/colab-launch`)).status).toBe(200);
    expect(await studyableNotebook(testDb.db, beaScope(), notebookRevisionId, now)).toMatchObject({
      resourceId: notebookId,
    });
  });

  test('A23 A26 work recorded while open cannot be continued once the topic locks again', async () => {
    // Clearing the review mark undoes Sampling's completion, so Inference locks again.
    await review(false);
    expect(await inferenceState('bea')).toBe('locked');

    const attempt = `${base}/exercise-attempts/${attemptId}`;
    const blocked = [
      ['check', { stepId: 'predict', response: 'yes' }],
      ['hint', { stepId: 'predict' }],
      ['solution', { stepId: 'predict' }],
      ['complete', { stepId: 'predict', response: 'yes' }],
      ['restart', {}],
    ] as const;
    for (const [action, body] of blocked) {
      expect((await call('bea', 'POST', `${attempt}/${action}`, body)).status).toBe(404);
    }

    // Her own note is kept, as on a scheduled resource, but the class discussion is not hers
    // to see and the note cannot be shared into it.
    const own = `${base}/annotations/${annotationId}`;
    expect((await call('bea', 'POST', `${own}/share`, { audience: 'class' })).status).toBe(404);
    const read = await call('bea', 'GET', `${resource(exerciseId)}/annotations`);
    expect(read.status).toBe(200);
    expect(read.body.annotations.map((a: { id: string }) => a.id)).toEqual([annotationId]);
    expect(read.body.threads).toEqual([]);
    expect(await notified('bea')).not.toContain(threadId);
  });
});
