import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { auditEvents, classes, posts } from '../../src/db/schema';
import { buildWorld, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
// Each request happens a second after the last, so posts have a stable order.
let ticks = 0;
const clock = () => new Date(now.getTime() + ++ticks * 1000);

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: clock,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

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

const base = (classId: string) => `/api/classes/${classId}`;

async function ask(who: PersonName, audience: 'instructor' | 'class', body: string) {
  const res = await call(
    who,
    'POST',
    `${base(ids.classB)}/resources/${ids.samplingReading}/threads`,
    { audience, anchor: passage, body },
  );
  expect(res.status).toBe(200);
  return res.body as Thread;
}

type Post = {
  id: string;
  parentId: string | null;
  body: string | null;
  edited: boolean;
  deleted: boolean;
  moderated: boolean;
  authorRole: string;
  can: { edit: boolean; delete: boolean; moderate: boolean };
};
type Thread = {
  id: string;
  status: string;
  posts: Post[];
  can: { reply: boolean; resolve: boolean; reopen: boolean };
};

const reply = (who: PersonName, threadId: string, body: string, parentId?: string) =>
  call(who, 'POST', `${base(ids.classB)}/threads/${threadId}/posts`, {
    body,
    ...(parentId && { parentId }),
  });

const setPolicy = (values: Partial<typeof classes.$inferInsert>) =>
  testDb.db.update(classes).set(values).where(eq(classes.id, ids.classB));

describe('discussion threads and moderation', () => {
  test('A05 an instructor’s reply to an instructor-only question stays hidden from classmates', async () => {
    const thread = await ask('bea', 'instructor', 'Why do samples vary?');
    const answered = await reply('marcus', thread.id, 'Because each draw is random.');
    expect(answered.status).toBe(200);
    const view = answered.body as Thread;
    expect(view.posts).toHaveLength(2);
    expect(view.posts[1]).toMatchObject({
      authorRole: 'instructor',
      parentId: view.posts[0]?.id,
      body: 'Because each draw is random.',
    });
    // The asker sees the response; a classmate cannot reach the thread at all.
    expect(((await reply('bea', thread.id, 'Thanks')).body as Thread).posts).toHaveLength(3);
    expect((await reply('priya', thread.id, 'Me too')).status).toBe(404);
    const spied = await call('priya', 'PUT', `${base(ids.classB)}/posts/${view.posts[0]?.id}`, {
      body: 'hijack',
    });
    expect(spied.status).toBe(404);
  });

  test('replies, edit indicator, and tombstone for a deleted parent', async () => {
    const thread = await ask('bea', 'class', 'What is a statistic?');
    const first = thread.posts[0] as Post;
    const r1 = (await reply('priya', thread.id, 'A function of the sample.')).body as Thread;
    const answer = r1.posts[1] as Post;
    expect(answer.can).toEqual({ edit: true, delete: true, moderate: false });

    const edited = await call('priya', 'PUT', `${base(ids.classB)}/posts/${answer.id}`, {
      body: 'A function of the sample alone.',
    });
    expect((edited.body as Thread).posts[1]).toMatchObject({
      body: 'A function of the sample alone.',
      edited: true,
    });
    expect((edited.body as Thread).posts[0]?.edited).toBe(false);

    // Replying to the reply, then deleting it: the parent stays as a tombstone.
    await reply('bea', thread.id, 'Got it', answer.id);
    const deleted = await call('priya', 'DELETE', `${base(ids.classB)}/posts/${answer.id}`);
    expect(deleted.status).toBe(200);
    const after = (deleted.body as Thread).posts;
    expect(after).toHaveLength(3);
    expect(after[1]).toMatchObject({ body: null, deleted: true });
    expect(after[2]?.body).toBe('Got it');

    // A leaf reply is removed outright; the question itself always remains as a tombstone.
    const gone = await call('bea', 'DELETE', `${base(ids.classB)}/posts/${after[2]?.id}`);
    expect((gone.body as Thread).posts).toHaveLength(2);
    const asked = await call('bea', 'DELETE', `${base(ids.classB)}/posts/${first.id}`);
    expect((asked.body as Thread).posts[0]).toMatchObject({
      body: null,
      deleted: true,
    });
    // Nobody can edit a deleted post.
    const late = await call('bea', 'PUT', `${base(ids.classB)}/posts/${first.id}`, { body: 'x' });
    expect(late.status).toBe(400);
  });

  test('students follow the class edit/delete policy; instructors are not bound by it', async () => {
    await setPolicy({ studentsEditPosts: false, studentsDeletePosts: false });
    try {
      const thread = await ask('bea', 'class', 'Policy question');
      const mine = thread.posts[0] as Post;
      expect(
        (
          (
            await call(
              'bea',
              'GET',
              `${base(ids.classB)}/resources/${ids.samplingReading}/annotations`,
            )
          ).body.threads as Thread[]
        ).find((t) => t.id === thread.id)?.posts[0]?.can,
      ).toEqual({ edit: false, delete: false, moderate: false });
      const edit = await call('bea', 'PUT', `${base(ids.classB)}/posts/${mine.id}`, { body: 'x' });
      expect(edit.status).toBe(400);
      expect(edit.body.message).toMatch(/does not let students edit/);
      const del = await call('bea', 'DELETE', `${base(ids.classB)}/posts/${mine.id}`);
      expect(del.status).toBe(400);

      const answered = (await reply('marcus', thread.id, 'Draft answer')).body as Thread;
      const own = answered.posts[1] as Post;
      expect(own.can).toMatchObject({ edit: true, delete: true });
      const fixed = await call('marcus', 'PUT', `${base(ids.classB)}/posts/${own.id}`, {
        body: 'Final answer',
      });
      expect(fixed.status).toBe(200);
    } finally {
      await setPolicy({ studentsEditPosts: true, studentsDeletePosts: true });
    }
  });

  test('A05 resolve and reopen: instructors resolve; the asker reopens their own question only', async () => {
    const thread = await ask('bea', 'class', 'Is this resolved?');
    const url = `${base(ids.classB)}/threads/${thread.id}/status`;
    expect((await call('bea', 'POST', url, { status: 'resolved' })).status).toBe(400);
    const resolved = await call('marcus', 'POST', url, { status: 'resolved' });
    expect(resolved.body).toMatchObject({ status: 'resolved' });
    expect((resolved.body as Thread).can).toMatchObject({
      resolve: false,
      reopen: true,
    });
    // A classmate may read a class thread but not reopen someone else's question.
    expect((await call('priya', 'POST', url, { status: 'open' })).status).toBe(400);
    const reopened = await call('bea', 'POST', url, { status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open' });
  });

  test('A05 moderation hides the post for everyone and leaves an audit record', async () => {
    const thread = await ask('bea', 'class', 'Spam question');
    const target = thread.posts[0] as Post;
    const url = `${base(ids.classB)}/posts/${target.id}/moderate`;
    // Students are not instructors: the route refuses them.
    expect((await call('priya', 'POST', url, { reason: 'no' })).status).toBe(403);
    expect((await call('marcus', 'POST', url, { reason: '' })).status).toBe(400);

    const moderated = await call('marcus', 'POST', url, {
      reason: 'Off topic',
    });
    expect(moderated.status).toBe(200);
    expect((moderated.body as Thread).posts[0]).toMatchObject({
      body: null,
      moderated: true,
    });
    const seen = await call(
      'priya',
      'GET',
      `${base(ids.classB)}/resources/${ids.samplingReading}/annotations`,
    );
    const theirs = (seen.body.threads as Thread[]).find((t) => t.id === thread.id);
    expect(theirs?.posts[0]).toMatchObject({ body: null, moderated: true });
    // The author cannot change a moderated post.
    const edit = await call('bea', 'PUT', `${base(ids.classB)}/posts/${target.id}`, { body: 'x' });
    expect(edit.status).toBe(400);

    const [row] = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'post.moderate'), eq(auditEvents.targetId, target.id)));
    expect(row).toMatchObject({
      actorId: ids.marcus,
      scopeKind: 'class',
      scopeId: ids.classB,
      after: { moderated: true, reason: 'Off topic' },
    });
    const [stored] = await testDb.db.select().from(posts).where(eq(posts.id, target.id));
    expect(stored?.moderationReason).toBe('Off topic');
    // Moderating again records nothing new.
    await call('marcus', 'POST', url, { reason: 'Again' });
    const rows = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'post.moderate'), eq(auditEvents.targetId, target.id)));
    expect(rows).toHaveLength(1);
  });

  test('an archived class refuses every discussion write but still reads', async () => {
    const thread = await ask('bea', 'class', 'Before archive');
    const mine = thread.posts[0] as Post;
    await setPolicy({ archivedAt: now });
    try {
      const attempts = [
        reply('bea', thread.id, 'late'),
        call('bea', 'PUT', `${base(ids.classB)}/posts/${mine.id}`, {
          body: 'late',
        }),
        call('bea', 'DELETE', `${base(ids.classB)}/posts/${mine.id}`),
        call('marcus', 'POST', `${base(ids.classB)}/threads/${thread.id}/status`, {
          status: 'resolved',
        }),
        call('marcus', 'POST', `${base(ids.classB)}/posts/${mine.id}/moderate`, { reason: 'x' }),
      ];
      for (const r of await Promise.all(attempts)) {
        expect(r.status).toBe(409);
        expect(r.body).toEqual({ error: 'class_archived' });
      }
      const read = await call(
        'bea',
        'GET',
        `${base(ids.classB)}/resources/${ids.samplingReading}/annotations`,
      );
      expect(read.status).toBe(200);
    } finally {
      await setPolicy({ archivedAt: null });
    }
  });

  test('A05 once the class no longer studies a reading, post routes answer 404 for it like the margin does', async () => {
    const thread = await ask('bea', 'class', 'Before it is hidden');
    const mine = thread.posts[0] as Post;
    // The class studies nothing once it has no adopted release; Bea's thread is still hers.
    const adopt = (releaseId: string | null) =>
      testDb.db.update(classes).set({ releaseId }).where(eq(classes.id, ids.classB));
    await adopt(null);
    try {
      const listing = `${base(ids.classB)}/resources/${ids.samplingReading}/annotations`;
      // Bea has no marks of her own here, so the listing is closed to her.
      expect((await call('bea', 'GET', listing)).status).toBe(404);
      const url = `${base(ids.classB)}/posts/${mine.id}`;
      expect((await call('bea', 'PUT', url, { body: 'late' })).status).toBe(404);
      expect((await call('bea', 'DELETE', url)).status).toBe(404);
      // The instructor cannot reach it either: with no release there is nothing to study.
      expect((await call('marcus', 'POST', `${url}/moderate`, { reason: 'x' })).status).toBe(404);
    } finally {
      await adopt(ids.releaseV1);
    }
  });

  test('deleting a post a reply depends on leaves a tombstone even when the reply is concurrent', async () => {
    const thread = await ask('bea', 'class', 'Race question');
    const first = thread.posts[0] as Post;
    const answer = (await reply('priya', thread.id, 'Leaf', first.id)).body as Thread;
    const leaf = answer.posts[1] as Post;
    const [deleted, replied] = await Promise.all([
      call('priya', 'DELETE', `${base(ids.classB)}/posts/${leaf.id}`),
      reply('bea', thread.id, 'Reply to the leaf', leaf.id),
    ]);
    expect(deleted.status).toBe(200);
    expect([200, 400]).toContain(replied.status);
    const rows = await testDb.db.select().from(posts).where(eq(posts.threadId, thread.id));
    const row = rows.find((p) => p.id === leaf.id);
    // Either the reply landed first (tombstone) or the delete did (the reply is refused as orphaned).
    if (replied.status === 200) expect(row?.deletedAt).not.toBeNull();
    else expect(row).toBeUndefined();
  });
});
