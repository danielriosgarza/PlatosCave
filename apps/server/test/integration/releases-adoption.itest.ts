import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { registerAffectedBy } from '../../src/content/adoption';
import {
  auditEvents,
  classes,
  courseReleases,
  releaseResources,
  resourceRevisions,
  resources,
  topics,
} from '../../src/db/schema';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

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

const call = async (who: PersonName, method: 'GET' | 'POST', url: string, payload?: object) => {
  const res = await app.inject({
    method,
    url,
    headers: { cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
};
const release = (who: PersonName, classId: string) =>
  call(who, 'GET', `/api/classes/${classId}/release`);
const publish = (who: PersonName, courseId = ids.statistics) =>
  call(who, 'POST', `/api/courses/${courseId}/releases`);
const adopt = (who: PersonName, classId: string, releaseId: string, expected: string | null) =>
  call(who, 'POST', `/api/classes/${classId}/adopt`, { releaseId, expectedReleaseId: expected });

type ReleaseView = {
  release: { id: string; version: number } | null;
  topics: {
    title: string;
    resources: { resourceId: string; revisionId: string; title: string }[];
  }[];
};
/** `topic: resource@revision` lines of a class release view. */
const pins = (view: ReleaseView) =>
  view.topics.flatMap((t) => t.resources.map((r) => `${t.title}: ${r.title}@${r.revisionId}`));

/** A draft edit: a new revision becomes the resource's head (what P1-04a's API will do). */
async function revise(resourceId: string, content: Record<string, unknown>, title?: string) {
  const { db } = testDb;
  const [current] = await db.select().from(resources).where(eq(resources.id, resourceId));
  if (!current) throw new Error('no resource');
  const [rev] = await db
    .insert(resourceRevisions)
    .values({
      resourceId,
      courseId: current.courseId,
      type: current.type,
      content,
      contentHash: JSON.stringify(content),
      createdBy: ids.elena,
    })
    .returning();
  if (!rev) throw new Error('no revision');
  await db
    .update(resources)
    .set({
      headRevisionId: rev.id,
      revision: sql`${resources.revision} + 1`,
      ...(title && { title }),
    })
    .where(eq(resources.id, resourceId));
  return rev;
}

describe('publication', () => {
  test('validation reports blocking errors and publishing refuses them', async () => {
    const { db } = testDb;
    const course = ids.linearModels;
    const empty = await call('olivia', 'GET', `/api/courses/${course}/releases/validation`);
    expect(empty.body.errors.map((e: { code: string }) => e.code)).toEqual(['empty_release']);

    const [topic] = await db
      .insert(topics)
      .values({
        courseId: course,
        position: 0,
        title: 'Least squares',
        prerequisites: [ids.sampling], // a topic of another course
        createdBy: ids.olivia,
      })
      .returning();
    if (!topic) throw new Error('no topic');
    const resource = (title: string, type: 'slides_pdf' | 'reading_native', position: number) => ({
      courseId: course,
      topicId: topic.id,
      type,
      title,
      position,
      createdBy: ids.olivia,
    });
    const [deck, empty2, borrowed, mistyped] = await db
      .insert(resources)
      .values([
        resource('Deck', 'slides_pdf', 0),
        resource('Notes', 'reading_native', 1),
        resource('Borrowed', 'reading_native', 2),
        resource('Mistyped', 'reading_native', 3),
      ])
      .returning();
    if (!deck || !empty2 || !borrowed || !mistyped) throw new Error('no resources');
    await revise(deck.id, { pages: 3 });
    // Points at a revision of a resource in another course.
    await db
      .update(resources)
      .set({ headRevisionId: ids.samplingReadingV1 })
      .where(eq(resources.id, borrowed.id));
    // Its head revision holds test content although the resource is a reading.
    const [wrongType] = await db
      .insert(resourceRevisions)
      .values({
        resourceId: mistyped.id,
        courseId: course,
        type: 'test',
        content: {},
        contentHash: 'x',
        createdBy: ids.olivia,
      })
      .returning();
    await db
      .update(resources)
      .set({ headRevisionId: wrongType?.id })
      .where(eq(resources.id, mistyped.id));

    const report = (await call('olivia', 'GET', `/api/courses/${course}/releases/validation`)).body;
    const codes = (list: { code: string; resourceId?: string }[]) =>
      list.map((i) => `${i.code}:${i.resourceId ?? '-'}`).sort();
    expect(codes(report.errors)).toEqual(
      [
        'broken_reference:-',
        `broken_reference:${borrowed.id}`,
        `broken_reference:${mistyped.id}`,
        `no_revision:${empty2.id}`,
        `unconverted_deck:${deck.id}`,
      ].sort(),
    );
    expect(codes(report.warnings)).toEqual([`missing_alternative:${deck.id}`]);

    const refused = await publish('olivia', course);
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: 'validation_failed', report });
    const rows = await db.select().from(courseReleases).where(eq(courseReleases.courseId, course));
    expect(rows).toEqual([]);

    // Fixing the errors lets the release through, with the remaining warning stored.
    await db.update(topics).set({ prerequisites: [] }).where(eq(topics.id, topic.id));
    await db
      .update(resources)
      .set({ archivedAt: now })
      .where(sql`${resources.id} in (${empty2.id}, ${borrowed.id}, ${mistyped.id})`);
    await db
      .update(resourceRevisions)
      .set({ derived: { status: 'ready' } })
      .where(eq(resourceRevisions.resourceId, deck.id));
    const ok = await publish('olivia', course);
    expect(ok.status).toBe(200);
    expect(ok.body.release.version).toBe(1);
    expect(ok.body.report.errors).toEqual([]);
    expect(codes(ok.body.report.warnings)).toEqual([`missing_alternative:${deck.id}`]);
    const pinned = await db
      .select({ resourceId: releaseResources.resourceId, tab: releaseResources.tab })
      .from(releaseResources)
      .where(eq(releaseResources.releaseId, ok.body.release.id));
    expect(pinned).toEqual([{ resourceId: deck.id, tab: 'slides' }]);
  });

  test('only publishers publish; publishing is audited', async () => {
    expect((await publish('marcus')).status).toBe(403);
    expect((await publish('sam')).status).toBe(404);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'release.publish'), eq(auditEvents.targetId, ids.releaseV1)),
      );
    expect(event).toMatchObject({
      actorId: ids.elena,
      scopeKind: 'course',
      scopeId: ids.statistics,
      after: { version: 1, topics: 2, resources: 3, warnings: 0 },
    });
  });
});

describe('class release and adoption', () => {
  test('A26 draft edits and new releases never change a class’s adopted release until it adopts', async () => {
    const v1 = [
      `Sampling: Why samples vary@${ids.samplingReadingV1}`,
      `Sampling: Sampling quiz@${ids.samplingQuizV1}`,
    ];
    const sam = await release('sam', ids.classA);
    expect(sam.status).toBe(200);
    expect(sam.body.release).toMatchObject({ id: ids.releaseV1, version: 1 });
    expect(sam.body.topics.map((t: { title: string }) => t.title)).toEqual([
      'Sampling',
      'Estimation',
    ]);
    // Students do not see hidden resources; the class instructor does.
    expect(pins(sam.body)).toEqual(v1);
    expect(pins((await release('priya', ids.classA)).body)).toEqual([
      ...v1,
      `Estimation: Answer key@${ids.answerKeyV1}`,
    ]);
    expect((await release('bea', ids.classA)).status).toBe(404);

    // Editing drafts and publishing v2 leaves both classes on v1.
    const edited = await revise(ids.samplingReading, { html: '<p>Edited.</p>' }, 'Samples vary');
    await testDb.db.update(topics).set({ title: 'Draft title' }).where(eq(topics.id, ids.sampling));
    expect(pins((await release('sam', ids.classA)).body)).toEqual(v1);
    const v2 = await publish('elena');
    expect(v2.body.release.version).toBe(2);
    for (const [who, classId] of [
      ['sam', ids.classA],
      ['bea', ids.classB],
      ['previewB', ids.classB],
    ] as const) {
      const view = (await release(who, classId)).body;
      expect(view.release.id, who).toBe(ids.releaseV1);
      expect(pins(view), who).toEqual(v1);
    }

    // The instructor sees what adopting v2 changes, then adopts it in class A only.
    const preview = await call(
      'priya',
      'GET',
      `/api/classes/${ids.classA}/adoption?releaseId=${v2.body.release.id}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.changed).toEqual([
      expect.objectContaining({
        resourceId: ids.samplingReading,
        title: 'Samples vary',
        fromRevisionId: ids.samplingReadingV1,
        toRevisionId: edited.id,
        fields: ['revision', 'title'],
      }),
    ]);
    expect(preview.body.totals).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
      annotations: 0,
      assignments: 0,
    });
    expect((await release('sam', ids.classA)).body.release.id).toBe(ids.releaseV1);

    const adopted = await adopt('priya', ids.classA, v2.body.release.id, ids.releaseV1);
    expect(adopted.status).toBe(200);
    expect(adopted.body.diff).toEqual(preview.body);
    const after = (await release('sam', ids.classA)).body;
    expect(after.release.version).toBe(2);
    expect(after.topics[0].title).toBe('Draft title');
    expect(pins(after)[0]).toBe(`Draft title: Samples vary@${edited.id}`);
    expect((await release('bea', ids.classB)).body.release.id).toBe(ids.releaseV1);
  });

  test('A16 adopting a changed test keeps the original revision and counts the work pinned to it', async () => {
    const { db } = testDb;
    // Stand-ins for the assignment and annotation tables (P3-15, P2-04): Bea started the quiz
    // and annotated the answer key in class B.
    const started = new Map([[ids.samplingQuizV1, 1]]);
    const marked = new Map([[ids.answerKeyV1, 2]]);
    const counted: string[][] = [];
    const removeAssignments = registerAffectedBy('assignments', async (_ex, scope, revisionIds) => {
      counted.push(revisionIds);
      return scope.classId === ids.classB ? started : new Map();
    });
    const removeAnnotations = registerAffectedBy('annotations', async (_ex, scope) =>
      scope.classId === ids.classB ? marked : new Map(),
    );
    try {
      const quizV2 = await revise(ids.samplingQuiz, {
        questions: [{ id: 'q1', prompt: 'Changed' }],
      });
      await db.update(resources).set({ archivedAt: now }).where(eq(resources.id, ids.answerKey));
      const v3 = (await publish('elena')).body.release;
      expect(v3.version).toBe(3);

      // An adoption based on a stale view of the class's release is refused, not applied.
      const stale = await adopt('marcus', ids.classB, v3.id, v3.id);
      expect(stale).toEqual({
        status: 409,
        body: { error: 'release_conflict', currentReleaseId: ids.releaseV1 },
      });

      const adopted = await adopt('marcus', ids.classB, v3.id, ids.releaseV1);
      expect(adopted.status).toBe(200);
      const { diff } = adopted.body;
      expect(diff.from).toEqual({ id: ids.releaseV1, version: 1 });
      expect(diff.to).toEqual({ id: v3.id, version: 3 });
      const quiz = diff.changed.find(
        (c: { resourceId: string }) => c.resourceId === ids.samplingQuiz,
      );
      expect(quiz).toMatchObject({
        fromRevisionId: ids.samplingQuizV1,
        toRevisionId: quizV2.id,
        fields: ['revision'],
        affected: { assignments: 1, annotations: 0 },
      });
      expect(diff.removed).toEqual([
        expect.objectContaining({
          resourceId: ids.answerKey,
          revisionId: ids.answerKeyV1,
          affected: { annotations: 2, assignments: 0 },
        }),
      ]);
      expect(diff.totals).toMatchObject({ removed: 1, changed: 2, annotations: 2, assignments: 1 });
      expect(counted.at(-1)?.sort()).toEqual(
        [ids.answerKeyV1, ids.samplingQuizV1, ids.samplingReadingV1].sort(),
      );

      // The started attempt's revision is untouched and still pinned by release v1.
      const [original] = await db
        .select()
        .from(resourceRevisions)
        .where(eq(resourceRevisions.id, ids.samplingQuizV1));
      expect(original?.content).toEqual({
        questions: [{ id: 'q1', prompt: 'What is a sampling distribution?' }],
      });
      const v1Pins = await db
        .select({ revisionId: releaseResources.resourceRevisionId })
        .from(releaseResources)
        .where(
          and(
            eq(releaseResources.releaseId, ids.releaseV1),
            eq(releaseResources.resourceId, ids.samplingQuiz),
          ),
        );
      expect(v1Pins).toEqual([{ revisionId: ids.samplingQuizV1 }]);
      expect(pins((await release('bea', ids.classB)).body)).toContain(
        `Draft title: Sampling quiz@${quizV2.id}`,
      );
    } finally {
      removeAssignments();
      removeAnnotations();
    }
  });

  test('history, audit, and refusals: other course, re-adoption, archived class, students', async () => {
    const list = await call('marcus', 'GET', `/api/classes/${ids.classB}/releases`);
    expect(list.status).toBe(200);
    expect(list.body.releases.map((r: { version: number }) => r.version)).toEqual([3, 2, 1]);
    const history = list.body.history.map(
      (h: {
        from: { version: number } | null;
        to: { version: number };
        actor: { name: string };
      }) => [h.from?.version ?? null, h.to.version, h.actor.name],
    );
    expect(history).toEqual([
      [null, 1, 'Marcus Webb'],
      [1, 3, 'Marcus Webb'],
    ]);
    const current = list.body.currentReleaseId;
    const adoptions = await testDb.db
      .select({ scopeId: auditEvents.scopeId, actorId: auditEvents.actorId })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'release.adopt'));
    expect(adoptions).toContainEqual({ scopeId: ids.classB, actorId: ids.marcus });

    const [foreign] = await testDb.db
      .select({ id: courseReleases.id })
      .from(courseReleases)
      .where(eq(courseReleases.courseId, ids.linearModels));
    if (!foreign) throw new Error('no foreign release');
    expect((await adopt('marcus', ids.classB, foreign.id, current)).status).toBe(404);
    const previewForeign = `/api/classes/${ids.classB}/adoption?releaseId=${foreign.id}`;
    expect((await call('marcus', 'GET', previewForeign)).status).toBe(404);

    // Adopting the current release again records nothing.
    const again = await adopt('marcus', ids.classB, current, current);
    expect(again.status).toBe(200);
    expect(again.body.diff.totals).toMatchObject({ added: 0, removed: 0, changed: 0 });
    const after = await call('marcus', 'GET', `/api/classes/${ids.classB}/releases`);
    expect(after.body.history).toHaveLength(2);

    expect((await adopt('bea', ids.classB, ids.releaseV1, current)).status).toBe(403);
    expect((await call('bea', 'GET', `/api/classes/${ids.classB}/releases`)).status).toBe(403);

    await testDb.db.update(classes).set({ archivedAt: now }).where(eq(classes.id, ids.classB));
    expect(await adopt('marcus', ids.classB, ids.releaseV1, current)).toEqual({
      status: 409,
      body: { error: 'class_archived' },
    });
  });
});
