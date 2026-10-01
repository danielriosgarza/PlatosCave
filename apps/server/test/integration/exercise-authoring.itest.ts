import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/content/adoption';
import { createResource, updateResource } from '../../src/content/drafts';
import { publishRelease, validateDrafts } from '../../src/content/releases';
import { resourceRevisions, resources } from '../../src/db/schema';
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
const course = asCourseScope(ids.statistics, ids.elena);

const step = (id: string, over: object = {}) => ({
  id,
  kind: 'text',
  title: 'Explain',
  prompt: 'Explain the result.',
  feedback: { saved: 'Saved.' },
  ...over,
});
const exercise = (over: object = {}) => ({
  schema: 'exercise.v1',
  steps: [step('explain')],
  ...over,
});

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
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

const add = async (title: string, content: Record<string, unknown>) => {
  const created = await createResource(
    testDb.db,
    course,
    ids.sampling,
    { type: 'exercise', title, content },
    now,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.value;
};

async function call(who: PersonName, url: string, method = 'POST') {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: world.cookie[who] },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('exercise authoring', () => {
  test('saving a changed definition adds a revision and keeps the earlier one as it was', async () => {
    const created = await add('Versioned', exercise());
    const first = created.head;
    const changed = exercise({ steps: [step('explain', { prompt: 'Explain it differently.' })] });
    const saved = await updateResource(
      testDb.db,
      course,
      created.id,
      { expectedRevision: created.revision, content: changed },
      now,
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(saved.value.head?.id).not.toBe(first?.id);
    const [old] = await testDb.db
      .select()
      .from(resourceRevisions)
      .where(eq(resourceRevisions.id, first?.id ?? ''));
    expect(old?.content).toEqual(exercise());
  });

  test('an invalid definition is refused when saved, with the step and the rule named', async () => {
    const created = await add('Refused', exercise());
    const bad = exercise({
      steps: [
        {
          id: 'inspect',
          kind: 'simulation',
          title: 'Inspect',
          prompt: 'Compare.',
          control: { name: 'n', label: 'n', min: 5, max: 200, step: 5, initial: 25 },
          observations: [],
          compare: [25, 102],
          feedback: { correct: 'Yes.', incomplete: 'No.' },
        },
      ],
    });
    const saved = await updateResource(
      testDb.db,
      course,
      created.id,
      { expectedRevision: created.revision, content: bad },
      now,
    );
    expect(saved).toMatchObject({ ok: false, reason: 'invalid' });
    expect(JSON.stringify(saved)).toContain('Step 1 “Inspect”: compare values must be');
  });

  test('publication reports an invalid exercise revision and publishing is refused', async () => {
    const created = await add('Legacy', exercise());
    // Revisions written before a rule existed can be invalid by today's rules.
    await testDb.db.execute(sql`alter table resource_revisions disable trigger user`);
    await testDb.db
      .update(resourceRevisions)
      .set({ content: exercise({ steps: [] }) })
      .where(eq(resourceRevisions.id, created.head?.id ?? ''));
    await testDb.db.execute(sql`alter table resource_revisions enable trigger user`);

    const report = await validateDrafts(testDb.db, course);
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: 'invalid_exercise',
        resourceId: created.id,
        message: expect.stringContaining('“Legacy”'),
      }),
    ]);
    expect((await publishRelease(testDb.db, course)).ok).toBe(false);
    await testDb.db.update(resources).set({ archivedAt: now }).where(eq(resources.id, created.id));
    expect((await validateDrafts(testDb.db, course)).errors).toEqual([]);
  });

  test('students see the points and hint policy of an exercise for credit, and none for practice', async () => {
    const credit = await add(
      'For credit',
      exercise({ credit: { points: 12, hintPolicy: 'reduces_credit' } }),
    );
    const practice = await add('Practice', exercise());
    const published = await publishRelease(testDb.db, course);
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    await adoptRelease(
      testDb.db,
      asClassScope(ids.classA, ids.statistics, ids.priya, { releaseId: ids.releaseV1 }),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    const open = (id: string) =>
      call('sam', `/api/classes/${ids.classA}/resources/${id}/exercise-attempt`);
    expect((await open(credit.id)).body.credit).toEqual({
      points: 12,
      hintPolicy: 'reduces_credit',
    });
    expect((await open(practice.id)).body.credit).toBeNull();
  });

  test('Start again is refused when the revision it would start on is not a valid exercise', async () => {
    const created = await add('Restart', exercise());
    const adopt = async (releaseId: string, expectedReleaseId: string) => {
      const adopted = await adoptRelease(
        testDb.db,
        asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: expectedReleaseId }),
        { releaseId, expectedReleaseId },
      );
      if (!adopted.ok) throw new Error(adopted.reason);
    };
    const first = await publishRelease(testDb.db, course);
    if (!first.ok) throw new Error(JSON.stringify(first.report));
    await adopt(first.release.id, ids.releaseV1);
    const url = `/api/classes/${ids.classB}`;
    const attempt = (await call('bea', `${url}/resources/${created.id}/exercise-attempt`)).body;

    // A newer revision is adopted, then turns out invalid by today's rules.
    const revised = await updateResource(
      testDb.db,
      course,
      created.id,
      {
        expectedRevision: created.revision,
        content: exercise({ steps: [step('explain', { prompt: 'A new prompt.' })] }),
      },
      now,
    );
    if (!revised.ok) throw new Error(JSON.stringify(revised));
    const second = await publishRelease(testDb.db, course);
    if (!second.ok) throw new Error(JSON.stringify(second.report));
    await adopt(second.release.id, first.release.id);
    await testDb.db.execute(sql`alter table resource_revisions disable trigger user`);
    await testDb.db
      .update(resourceRevisions)
      .set({ content: { schema: 'exercise.v1', steps: [] } })
      .where(eq(resourceRevisions.id, revised.value.head?.id ?? ''));
    await testDb.db.execute(sql`alter table resource_revisions enable trigger user`);

    const restarted = await call('bea', `${url}/exercise-attempts/${attempt.id}/restart`);
    expect(restarted.status).toBe(400);
    // The attempt stays current: nothing was superseded.
    const again = await call('bea', `${url}/resources/${created.id}/exercise-attempt`);
    expect(again.status).toBe(400);
    const { rows } = await testDb.db.execute(
      sql`select count(*)::int as n from exercise_attempts where superseded_at is not null`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
