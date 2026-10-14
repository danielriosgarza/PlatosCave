import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { createUser } from '../../src/db/identity';
import { annotations, auditEvents, posts, resources, threads } from '../../src/db/schema';
import { buildWorld, cookieFor, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

// Open class (§13, N10; A49, server part): a per-class `open` setting, off unless set. In an
// open class the server refuses every post to the class or to instructors, whoever sends it,
// and private notes still save.

const now = new Date('2026-10-01T09:00:00Z');
// Each request happens a second after the last, so posts and audit events have a stable order.
let ticks = 0;
const clock = () => new Date(now.getTime() + ++ticks * 1000);

/** Someone with an account and no membership, who joins class B by its link. */
const visitorId = '00000000-0000-4000-8000-000000000049';
type Who = PersonName | 'visitor';

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let visitorCookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  await createUser(testDb.db, {
    id: visitorId,
    email: 'visitor@example.test',
    name: 'Vic Visitor',
  });
  visitorCookie = cookieFor((await createSession(testDb.db, visitorId, { now })).token);
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

async function call(who: Who, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: who === 'visitor' ? visitorCookie : world.cookie[who] },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}

const classB = `/api/classes/${ids.classB}`;
const reading = `${classB}/resources/${ids.samplingReading}`;
const setOpen = (who: Who, open: boolean) => call(who, 'PUT', `${classB}/open`, { open });
const ask = (who: Who, audience: 'instructor' | 'class', body: string) =>
  call(who, 'POST', `${reading}/threads`, { audience, anchor: { kind: 'none' }, body });
const reply = (who: Who, threadId: string, body: string) =>
  call(who, 'POST', `${classB}/threads/${threadId}/posts`, { body });
const margin = async (who: Who) => (await call(who, 'GET', `${reading}/annotations`)).body;

const tally = async () => ({
  threads: (await testDb.db.select({ n: count() }).from(threads))[0]?.n,
  posts: (await testDb.db.select({ n: count() }).from(posts))[0]?.n,
});
const openEvents = () =>
  testDb.db
    .select({ before: auditEvents.before, after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'class.open'), eq(auditEvents.scopeId, ids.classB)))
    .orderBy(auditEvents.createdAt);
const refused = { status: 409, body: { error: 'class_open' } };

/** Bea's question to the class, asked before the class was opened. */
let earlier: { id: string; posts: { id: string }[] };

describe('open class (§13, N10)', () => {
  test('a class is not open unless set, and is not opened while its release has manually graded test parts', async () => {
    expect((await call('bea', 'GET', classB)).body).toMatchObject({ open: false });
    expect((await call('sam', 'GET', `/api/classes/${ids.classA}`)).body).toMatchObject({
      open: false,
    });
    // Release v1's quiz has an explanation question, which an instructor grades by hand.
    expect(await setOpen('elena', true)).toEqual({
      status: 409,
      body: { error: 'manual_grading' },
    });
    expect((await call('bea', 'GET', classB)).body).toMatchObject({ open: false });
    expect(await openEvents()).toEqual([]);
  });

  test('A49 a manager opens the class once its release needs no grader', async () => {
    const asked = await ask('bea', 'class', 'Does a larger sample vary less?');
    expect(asked.status).toBe(200);
    earlier = asked.body;
    // The draft drops its quiz, so the next release holds no test part that needs a grader.
    await testDb.db
      .update(resources)
      .set({ archivedAt: now })
      .where(eq(resources.id, ids.samplingQuiz));
    const published = await call('elena', 'POST', `/api/courses/${ids.statistics}/releases`);
    expect(published.status).toBe(200);
    const adopted = await call('marcus', 'POST', `${classB}/adopt`, {
      releaseId: published.body.release.id,
      expectedReleaseId: ids.releaseV1,
    });
    expect(adopted.status).toBe(200);

    expect(await setOpen('marcus', true)).toMatchObject({ status: 403 });
    expect(await setOpen('elena', true)).toEqual({
      status: 200,
      body: { id: ids.classB, open: true },
    });
    expect((await call('bea', 'GET', classB)).body).toMatchObject({ open: true });
    expect((await call('sam', 'GET', `/api/classes/${ids.classA}`)).body).toMatchObject({
      open: false,
    });
    expect(await openEvents()).toEqual([
      { before: { open: false }, after: { open: true, via: 'course_owner' } },
    ]);
  });

  test('A49 a visitor joins the open class by its link, and the server refuses every post to the class or to instructors', async () => {
    const invite = await call('elena', 'POST', `${classB}/invites`, { kind: 'enrolment' });
    expect(invite.status).toBe(200);
    const joined = await call('visitor', 'POST', '/api/join', { code: invite.body.code });
    expect(joined).toMatchObject({ status: 200, body: { classId: ids.classB, role: 'student' } });
    expect((await call('visitor', 'GET', classB)).body).toMatchObject({
      open: true,
      role: 'student',
    });

    const before = await tally();
    expect(await ask('visitor', 'class', 'Anyone else stuck on question 2?')).toEqual(refused);
    expect(await ask('visitor', 'instructor', 'Can you check my answer?')).toEqual(refused);
    // Posting is off for the whole class, instructors included.
    expect(await ask('marcus', 'class', 'Office hours moved to Friday.')).toEqual(refused);
    expect(await reply('visitor', earlier.id, 'Yes, by the square root of n.')).toEqual(refused);
    expect(await reply('marcus', earlier.id, 'It does.')).toEqual(refused);
    const edited = await call('bea', 'PUT', `${classB}/posts/${earlier.posts[0]?.id}`, {
      body: 'Edited after the class was opened',
    });
    expect(edited).toEqual(refused);
    expect(await tally()).toEqual(before);

    // The earlier discussion stays readable, and offers no reply or edit.
    const thread = (await margin('bea')).threads.find((t: { id: string }) => t.id === earlier.id);
    expect(thread.can.reply).toBe(false);
    expect(thread.posts[0]).toMatchObject({
      body: 'Does a larger sample vary less?',
      can: { edit: false },
    });
  });

  test('A49 private notes still save in an open class, and sharing one is refused', async () => {
    const created = await call('visitor', 'POST', `${reading}/annotations`, {
      kind: 'note',
      anchor: { kind: 'none' },
      body: 'Variance shrinks with n.',
    });
    expect(created.status).toBe(200);
    const saved = await call('visitor', 'PUT', `${classB}/annotations/${created.body.id}`, {
      expectedRevision: 1,
      body: 'Variance shrinks with 1/n.',
    });
    expect(saved).toMatchObject({ status: 200, body: { revision: 2, audience: 'private' } });

    const before = await tally();
    const shared = await call('visitor', 'POST', `${classB}/annotations/${created.body.id}/share`, {
      audience: 'instructor',
    });
    expect(shared).toEqual(refused);
    expect(await tally()).toEqual(before);
    const [note] = await testDb.db
      .select()
      .from(annotations)
      .where(eq(annotations.id, created.body.id));
    expect(note).toMatchObject({ authorId: visitorId, body: 'Variance shrinks with 1/n.' });
    expect((await margin('visitor')).annotations).toEqual([
      expect.objectContaining({ id: created.body.id, body: 'Variance shrinks with 1/n.' }),
    ]);
  });

  test('closing the class again lets its members post', async () => {
    expect(await setOpen('elena', false)).toEqual({
      status: 200,
      body: { id: ids.classB, open: false },
    });
    // Setting the value the class already has changes nothing and records nothing.
    expect((await setOpen('elena', false)).status).toBe(200);
    expect(await openEvents()).toHaveLength(2);
    expect((await ask('visitor', 'instructor', 'Can you check my answer?')).status).toBe(200);
    expect((await reply('marcus', earlier.id, 'It does.')).status).toBe(200);
  });
});
