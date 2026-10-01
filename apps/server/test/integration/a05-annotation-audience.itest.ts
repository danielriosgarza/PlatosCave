import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
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

const draftId = '00000000-0000-4000-8000-000000000999';
const drawing = [
  {
    tool: 'pen',
    color: '#1f6feb',
    width: 2,
    points: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
  },
];
const same = (body: unknown) => ({ status: 200, body });

const passage = {
  kind: 'text',
  blockId: '0123456789ab',
  start: 6,
  end: 12,
  quote: 'sample',
  prefix: 'Every ',
  suffix: ' tells a slightly',
} as const;

async function call(who: PersonName, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

const resourceUrl = (classId: string, resourceId = ids.samplingReading) =>
  `/api/classes/${classId}/resources/${resourceId}`;
const annotationUrl = (classId: string, id: string) => `/api/classes/${classId}/annotations/${id}`;

const list = async (who: PersonName, classId: string) => {
  const res = await call(who, 'GET', `${resourceUrl(classId)}/annotations`);
  expect(res.status).toBe(200);
  return res.body as { annotations: { id: string }[]; threads: { id: string }[] };
};
const ids_ = (items: { id: string }[]) => items.map((i) => i.id);

async function create(who: PersonName, classId: string, body: object) {
  const res = await call(who, 'POST', `${resourceUrl(classId)}/annotations`, body);
  expect(res.status).toBe(200);
  return res.body;
}

async function ask(who: PersonName, classId: string, audience: string, body: string) {
  const res = await call(who, 'POST', `${resourceUrl(classId)}/threads`, {
    audience,
    anchor: passage,
    body,
  });
  expect(res.status).toBe(200);
  return res.body;
}

describe('A05 private annotations and an instructor question', () => {
  test('A05 instructor sees only the shared question; a classmate sees neither', async () => {
    const highlight = await create('bea', ids.classB, { kind: 'highlight', anchor: passage });
    const note = await create('bea', ids.classB, {
      kind: 'note',
      anchor: passage,
      body: 'Is this the sampling distribution?',
    });
    const question = await ask('bea', ids.classB, 'instructor', 'Why do samples vary at all?');
    expect(highlight).toMatchObject({
      audience: 'private',
      kind: 'highlight',
      resourceRevisionId: ids.samplingReadingV1,
    });
    expect(question).toMatchObject({
      audience: 'instructor',
      status: 'open',
      author: { id: ids.bea, name: 'Bea Lindqvist' },
      posts: [{ body: 'Why do samples vary at all?', deleted: false, edited: false }],
    });

    const own = await list('bea', ids.classB);
    expect(ids_(own.annotations).sort()).toEqual([highlight.id, note.id].sort());
    expect(ids_(own.threads)).toContain(question.id);

    const teacher = await list('marcus', ids.classB);
    expect(teacher.annotations).toEqual([]);
    expect(teacher.threads).toContainEqual(question);

    // Priya studies in class B: a classmate sees neither the note nor the instructor question.
    const classmate = await list('priya', ids.classB);
    expect(classmate.annotations).toEqual([]);
    expect(ids_(classmate.threads)).not.toContain(question.id);

    const notified = (who: PersonName) =>
      call(who, 'GET', `/api/classes/${ids.classB}/notifications`).then((r) =>
        r.body.items.map((i: { threadId: string }) => i.threadId),
      );
    expect(await notified('marcus')).toContain(question.id);
    expect(await notified('priya')).not.toContain(question.id);
    expect(await notified('bea')).not.toContain(question.id);
  });

  test('A05 a class comment reaches classmates, still without the private note', async () => {
    const comment = await ask('bea', ids.classB, 'class', 'This reading pairs with the quiz.');
    for (const who of ['priya', 'marcus', 'bea'] as const) {
      expect(ids_((await list(who, ids.classB)).threads)).toContain(comment.id);
    }
    expect((await list('priya', ids.classB)).annotations).toEqual([]);
  });

  test('A05 nobody but the author can save, share or delete a private note', async () => {
    const note = await create('bea', ids.classB, { kind: 'note', anchor: passage, body: 'Mine' });
    const url = annotationUrl(ids.classB, note.id);
    for (const who of ['marcus', 'priya', 'previewB'] as const) {
      expect((await call(who, 'PUT', url, { expectedRevision: 1, body: 'x' })).status).toBe(404);
      expect((await call(who, 'POST', `${url}/share`, { audience: 'class' })).status).toBe(404);
      expect((await call(who, 'DELETE', url)).status).toBe(404);
    }
    expect((await list('bea', ids.classB)).annotations).toContainEqual(note);
    expect((await call('bea', 'DELETE', url)).body).toEqual({ id: note.id });
    expect(ids_((await list('bea', ids.classB)).annotations)).not.toContain(note.id);
  });

  test('A05 sharing is an explicit action that copies only the note and its quoted context', async () => {
    const note = await create('bea', ids.classB, {
      kind: 'note',
      anchor: passage,
      body: 'What makes a sample representative?',
    });
    const res = await call('bea', 'POST', `${annotationUrl(ids.classB, note.id)}/share`, {
      audience: 'instructor',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      audience: 'instructor',
      anchor: passage,
      resourceRevisionId: ids.samplingReadingV1,
      posts: [{ body: 'What makes a sample representative?' }],
    });
    // The note stays private and unchanged; only the new thread is shared.
    expect((await list('bea', ids.classB)).annotations).toContainEqual(note);
    expect((await list('marcus', ids.classB)).annotations).toEqual([]);
    expect(ids_((await list('marcus', ids.classB)).threads)).toContain(res.body.id);
    expect(ids_((await list('priya', ids.classB)).threads)).not.toContain(res.body.id);

    const highlight = await create('bea', ids.classB, { kind: 'highlight', anchor: passage });
    const empty = await call('bea', 'POST', `${annotationUrl(ids.classB, highlight.id)}/share`, {
      audience: 'class',
    });
    expect(empty.status).toBe(400);
  });

  test('autosave applies the expected revision and returns the server copy on conflict', async () => {
    const note = await create('bea', ids.classB, { kind: 'note', anchor: passage, body: 'v1' });
    const url = annotationUrl(ids.classB, note.id);
    const saved = await call('bea', 'PUT', url, { expectedRevision: 1, body: 'v2 longer draft' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ body: 'v2 longer draft', revision: 2 });
    const stale = await call('bea', 'PUT', url, { expectedRevision: 1, body: 'v2' });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'revision_conflict', current: saved.body });
    // A blur without edits, even from a tab holding an older revision, changes nothing.
    for (const expectedRevision of [2, 1]) {
      const same = await call('bea', 'PUT', url, { expectedRevision, body: 'v2 longer draft' });
      expect(same).toEqual({ status: 200, body: saved.body });
    }
    expect(await call('bea', 'PUT', url, { expectedRevision: 2 })).toEqual(same(saved.body));
    const moved = await call('bea', 'PUT', url, { expectedRevision: 2, anchor: { kind: 'none' } });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toBe('A mark cannot move to another kind of anchor');
  });

  test('A26 annotations attach only to the class’s adopted release, never to drafts or hidden resources', async () => {
    const note = { kind: 'note', anchor: { kind: 'none' }, body: 'Key?' };
    const hidden = resourceUrl(ids.classB, ids.answerKey);
    expect((await call('bea', 'POST', `${hidden}/annotations`, note)).status).toBe(404);
    expect(
      (await call('bea', 'POST', `${hidden}/threads`, { ...note, audience: 'class' })).status,
    ).toBe(404);
    expect((await call('marcus', 'POST', `${hidden}/annotations`, note)).status).toBe(200);
    // An instructor's thread on a hidden resource reaches neither the student's margin nor notifications.
    const onHidden = await call('marcus', 'POST', `${hidden}/threads`, {
      audience: 'class',
      anchor: { kind: 'none' },
      body: 'Answers for instructors.',
    });
    expect(onHidden.status).toBe(200);
    // Without marks of her own there, the hidden resource is unknown to the student.
    expect(await call('bea', 'GET', `${hidden}/annotations`)).toEqual({
      status: 404,
      body: { error: 'not found' },
    });
    expect(ids_((await call('marcus', 'GET', `${hidden}/annotations`)).body.threads)).toEqual([
      onHidden.body.id,
    ]);
    const items = (await call('bea', 'GET', `/api/classes/${ids.classB}/notifications`)).body.items;
    expect(items.map((i: { threadId: string }) => i.threadId)).not.toContain(onHidden.body.id);

    // A draft added after the release is not part of any class.
    await testDb.db.insert(resources).values({
      id: draftId,
      courseId: ids.statistics,
      topicId: ids.sampling,
      type: 'reading_native',
      title: 'Draft reading',
      position: 5,
      createdBy: ids.elena,
    });
    for (const who of ['bea', 'marcus'] as const) {
      const draft = resourceUrl(ids.classB, draftId);
      expect((await call(who, 'POST', `${draft}/annotations`, note)).status).toBe(404);
    }
  });

  test('anchors must fit the annotation kind and the resource’s material', async () => {
    const url = `${resourceUrl(ids.classB)}/annotations`;
    const pdf = { kind: 'pdf', page: 0, rect: { x: 0, y: 0, w: 0.5, h: 0.1 } };
    const bad = [
      { kind: 'highlight', anchor: { kind: 'none' } },
      { kind: 'sketch', anchor: passage },
      { kind: 'sketch', anchor: { kind: 'figure', figureId: 'fig-1', strokes: [] } },
      { kind: 'note', anchor: { ...passage, end: 2 } },
      // A native reading has text blocks and figures, not PDF pages or slides.
      { kind: 'highlight', anchor: pdf },
      { kind: 'note', anchor: { kind: 'slide', page: 1 } },
    ];
    for (const body of bad) expect((await call('bea', 'POST', url, body)).status).toBe(400);
    const quiz = resourceUrl(ids.classB, ids.samplingQuiz);
    const onQuiz = await call('bea', 'POST', `${quiz}/threads`, {
      audience: 'class',
      anchor: passage,
      body: 'q1?',
    });
    expect(onQuiz.status).toBe(400);
  });

  test('sharing a sketch shares its drawing', async () => {
    const anchor = { kind: 'figure', figureId: 'fig-1', strokes: drawing };
    const sketch = await create('bea', ids.classB, { kind: 'sketch', anchor, body: 'My curve' });
    expect(sketch.anchor).toEqual(anchor);
    const res = await call('bea', 'POST', `${annotationUrl(ids.classB, sketch.id)}/share`, {
      audience: 'instructor',
    });
    expect(res.body).toMatchObject({ anchor, posts: [{ body: 'My curve' }] });
    const redrawn = { ...anchor, strokes: [...drawing, ...drawing] };
    const saved = await call('bea', 'PUT', annotationUrl(ids.classB, sketch.id), {
      expectedRevision: 1,
      anchor: redrawn,
    });
    expect(saved.body).toMatchObject({ anchor: redrawn, revision: 2 });
  });

  test('a preview principal’s posts never reach the real class', async () => {
    const preview = await ask('previewB', ids.classB, 'class', 'Testing the discussion.');
    expect(ids_((await list('previewB', ids.classB)).threads)).toContain(preview.id);
    for (const who of ['bea', 'priya', 'marcus'] as const) {
      expect(ids_((await list(who, ids.classB)).threads)).not.toContain(preview.id);
    }
  });
});

describe('A21 discussions are per class', () => {
  test('A21 the other cohort of the same course never sees a class discussion or note', async () => {
    const comment = await ask('bea', ids.classB, 'class', 'Class B only.');
    const note = await create('bea', ids.classB, { kind: 'note', anchor: passage, body: 'B' });

    // Same course release and resource, other class: Sam studies in A, Priya teaches A.
    for (const who of ['sam', 'priya'] as const) {
      const a = await list(who, ids.classA);
      expect(ids_(a.threads)).not.toContain(comment.id);
      expect(ids_(a.annotations)).not.toContain(note.id);
      const items = (await call(who, 'GET', `/api/classes/${ids.classA}/notifications`)).body.items;
      expect(items.map((i: { threadId: string }) => i.threadId)).not.toContain(comment.id);
      const viaA = annotationUrl(ids.classA, note.id);
      expect((await call(who, 'PUT', viaA, { expectedRevision: 1, body: 'x' })).status).toBe(404);
      expect((await call(who, 'DELETE', viaA)).status).toBe(404);
    }
    expect((await call('sam', 'GET', `${resourceUrl(ids.classB)}/annotations`)).status).toBe(404);
    const viaB = await call('sam', 'GET', `/api/classes/${ids.classB}/notifications`);
    expect(viaB).toEqual({ status: 404, body: { error: 'not found' } });

    // Class A's own discussion stays in class A.
    const own = await ask('sam', ids.classA, 'class', 'Class A only.');
    expect(ids_((await list('priya', ids.classA)).threads)).toContain(own.id);
    expect(ids_((await list('bea', ids.classB)).threads)).not.toContain(own.id);
  });
});

describe('work on a resource the class stops using', () => {
  // Last in the file: moves class B to a release without the quiz.
  test('a student keeps their own notes after an adoption removes the resource', async () => {
    const quiz = resourceUrl(ids.classB, ids.samplingQuiz);
    const created = await call('bea', 'POST', `${quiz}/annotations`, {
      kind: 'note',
      anchor: { kind: 'none' },
    });
    const note = created.body;
    expect(created.status).toBe(200);
    const before = await call('marcus', 'POST', `${quiz}/threads`, {
      audience: 'class',
      anchor: { kind: 'none' },
      body: 'Quiz opens Friday.',
    });
    expect(before.status).toBe(200);

    await testDb.db
      .update(resources)
      .set({ archivedAt: now })
      .where(eq(resources.id, ids.samplingQuiz));
    await testDb.db.delete(resources).where(eq(resources.id, draftId));
    const v2 = await publishRelease(testDb.db, asCourseScope(ids.statistics, ids.elena));
    if (!v2.ok) throw new Error(JSON.stringify(v2.report));
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: ids.releaseV1 }),
      { releaseId: v2.release.id, expectedReleaseId: ids.releaseV1 },
    );
    expect(adopted.ok).toBe(true);

    const after = await call('bea', 'GET', `${quiz}/annotations`);
    // The note is kept; it has no placement now because the class no longer studies the quiz.
    expect(after.body).toEqual({ annotations: [{ ...note, placement: null }], threads: [] });
    const saved = await call('bea', 'PUT', annotationUrl(ids.classB, note.id), {
      expectedRevision: 1,
      body: 'Still mine',
    });
    expect(saved.body).toMatchObject({ body: 'Still mine', revision: 2 });
    expect(
      (await call('bea', 'POST', `${quiz}/annotations`, { kind: 'note', anchor: { kind: 'none' } }))
        .status,
    ).toBe(404);
    const items = (await call('bea', 'GET', `/api/classes/${ids.classB}/notifications`)).body.items;
    expect(items.map((i: { threadId: string }) => i.threadId)).not.toContain(before.body.id);
  });
});
