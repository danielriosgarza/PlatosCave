import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { createCourse, createUser } from '../../src/db/identity';
import { auditEvents, courseMemberships } from '../../src/db/schema';
import { buildWorld, cookieFor, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * Course ownership: an owner adds and withdraws owners (§3, §13; plan item P4-09a). No acceptance
 * scenario is assigned to this item.
 */

const start = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => start,
    mode: 'relay',
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function send(cookie: string, method: string, url: string, payload?: object) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie },
    ...(payload && { payload }),
  });
  return { status: res.statusCode, body: res.json() };
}
const call = (who: PersonName, method: string, url: string, payload?: object) =>
  send(world.cookie[who], method, url, payload);

const ownerUrl = (courseId: string, userId: string) =>
  `/api/courses/${courseId}/members/${userId}/owner`;
const setOwner = (who: PersonName, userId: string, granted: boolean, courseId = ids.statistics) =>
  call(who, 'PUT', ownerUrl(courseId, userId), { granted });
const membership = async (courseId: string, userId: string) =>
  (
    await testDb.db
      .select()
      .from(courseMemberships)
      .where(and(eq(courseMemberships.courseId, courseId), eq(courseMemberships.userId, userId)))
  )[0];
const events = (targetId: string) =>
  testDb.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'grant.owner'), eq(auditEvents.targetId, targetId)));

/** A person of the test's own, with a session cookie, who is not part of the standard world. */
async function newPerson(key: string) {
  const id = await createUser(testDb.db, { email: `${key}@example.test`, name: key });
  const { token } = await createSession(testDb.db, id, { now: start });
  return { id, cookie: cookieFor(token) };
}

describe('granting and withdrawing course ownership', () => {
  test('an owner grants ownership to an instructor of the course, audited, and it takes effect', async () => {
    expect(await setOwner('elena', ids.marcus, true)).toEqual({
      status: 200,
      body: { userId: ids.marcus, owner: true },
    });
    expect(await membership(ids.statistics, ids.marcus)).toMatchObject({
      owner: true,
      editor: true,
    });
    const [event] = await events(ids.marcus);
    expect(event).toMatchObject({
      actorId: ids.elena,
      scopeKind: 'course',
      scopeId: ids.statistics,
      before: { owner: false },
      after: { owner: true },
    });
    // The new owner can use an owner-only route at once.
    expect(
      (
        await call(
          'marcus',
          'PUT',
          `/api/courses/${ids.statistics}/members/${ids.priya}/publisher`,
          { granted: true },
        )
      ).status,
    ).toBe(200);
    // Granting again changes nothing and records nothing.
    expect((await setOwner('elena', ids.marcus, true)).status).toBe(200);
    expect(await events(ids.marcus)).toHaveLength(1);
  });

  test('a delegate who only publishes is not an instructor and cannot be made an owner', async () => {
    expect(await setOwner('elena', ids.ines, true)).toEqual({
      status: 409,
      body: { error: 'not_course_staff' },
    });
    expect((await membership(ids.statistics, ids.ines))?.owner).toBe(false);
  });

  test('only an owner changes ownership, and only for people who work on the course', async () => {
    for (const who of ['noor', 'ines', 'priya'] as const) {
      expect((await setOwner(who, ids.sam, true)).status, who).toBe(403);
    }
    // Not a member of the course at all: 404, as for every course route.
    for (const who of ['sam', 'olivia'] as const) {
      expect((await setOwner(who, ids.sam, true)).status, who).toBe(404);
    }
    // Students, outsiders and preview principals cannot be made owners.
    for (const userId of [ids.sam, ids.bea, ids.olivia, ids.ines]) {
      expect(await setOwner('elena', userId, true), userId).toEqual({
        status: 409,
        body: { error: 'not_course_staff' },
      });
    }
    expect((await setOwner('elena', ids.previewB, true)).status).toBe(404);
    // Withdrawing answers the same for an account that does not exist or is a preview principal.
    expect((await setOwner('elena', ids.previewB, false)).status).toBe(404);
    expect((await setOwner('elena', '00000000-0000-4000-8000-0000000fffff', false)).status).toBe(
      404,
    );
    expect((await setOwner('elena', '00000000-0000-4000-8000-0000000fffff', true)).status).toBe(
      404,
    );
    expect(await membership(ids.statistics, ids.sam)).toBeUndefined();
  });

  test('ownership needs a sign-in from the last 15 minutes', async () => {
    const stale = await createSession(testDb.db, ids.elena, {
      now: start,
      authTime: new Date(start.getTime() - 16 * 60_000),
    });
    const res = await send(cookieFor(stale.token), 'PUT', ownerUrl(ids.statistics, ids.noor), {
      granted: true,
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('recent_auth_required');
    expect((await membership(ids.statistics, ids.noor))?.owner).toBe(false);
  });

  test('withdrawing keeps publishing, and ends the old owner’s owner-only access', async () => {
    // Marcus owns the course with Elena; she hands it to him and steps back.
    expect((await setOwner('elena', ids.elena, false)).status).toBe(200);
    // Elena created the course and teaches no class, so draft editing ends with ownership.
    expect(await membership(ids.statistics, ids.elena)).toMatchObject({
      owner: false,
      editor: false,
      publisher: true,
    });
    expect((await setOwner('elena', ids.noor, true)).status).toBe(403);
    expect(await events(ids.elena)).toHaveLength(1);
    // Withdrawing from someone who is not an owner is a no-op.
    expect((await setOwner('marcus', ids.elena, false)).status).toBe(200);
    expect(await events(ids.elena)).toHaveLength(1);
  });

  test('the last active owner cannot withdraw, themselves or by another owner', async () => {
    expect(await setOwner('marcus', ids.marcus, false)).toEqual({
      status: 409,
      body: { error: 'last_owner' },
    });
    expect((await membership(ids.statistics, ids.marcus))?.owner).toBe(true);

    // A deactivated owner is not an active one: Priya is made owner, then closes her account.
    expect((await setOwner('marcus', ids.priya, true)).status).toBe(200);
    expect((await call('priya', 'POST', '/api/me/deactivate', { confirm: true })).status).toBe(200);
    expect(await setOwner('marcus', ids.marcus, false)).toEqual({
      status: 409,
      body: { error: 'last_owner' },
    });
    // A deactivated person cannot be given ownership again.
    expect((await setOwner('marcus', ids.priya, true)).status).toBe(404);
  });
});

describe('handing a course over before leaving', () => {
  test('the only owner hands the course over, then closes the account', async () => {
    const tom = await newPerson('tom');
    await testDb.db
      .insert(courseMemberships)
      .values({ courseId: ids.linearModels, userId: tom.id, editor: true });
    expect((await call('olivia', 'POST', '/api/me/deactivate', { confirm: true })).body).toEqual({
      error: 'owns_courses',
    });
    // An archived course can be handed over as well.
    expect((await call('olivia', 'POST', `/api/courses/${ids.linearModels}/archive`)).status).toBe(
      200,
    );
    expect((await setOwner('olivia', tom.id, true, ids.linearModels)).status).toBe(200);
    expect((await call('olivia', 'POST', '/api/me/deactivate', { confirm: true })).status).toBe(
      200,
    );
    // Tom is now the only active owner and cannot leave in turn.
    expect((await send(tom.cookie, 'POST', '/api/me/deactivate', { confirm: true })).body).toEqual({
      error: 'owns_courses',
    });
    expect(
      (await send(tom.cookie, 'POST', `/api/courses/${ids.linearModels}/restore`)).status,
    ).toBe(200);
  });

  test('two owners withdrawing each other at once leave one owner', async () => {
    const a = await newPerson('ada');
    const b = await newPerson('ben');
    const courseId = await createCourse(testDb.db, { title: 'Race', ownerId: a.id });
    await testDb.db.insert(courseMemberships).values({ courseId, userId: b.id, editor: true });
    expect((await send(a.cookie, 'PUT', ownerUrl(courseId, b.id), { granted: true })).status).toBe(
      200,
    );
    const [one, other] = await Promise.all([
      send(a.cookie, 'PUT', ownerUrl(courseId, b.id), { granted: false }),
      send(b.cookie, 'PUT', ownerUrl(courseId, a.id), { granted: false }),
    ]);
    // One withdrawal wins; the other is refused, either as the last owner or, when it was
    // resolved after the first, as no longer an owner (403 whether the role was checked before the transaction or inside it).
    expect([one.status, other.status].filter((status) => status === 200)).toHaveLength(1);
    expect(
      [one.status, other.status].filter((status) => status === 409 || status === 403),
    ).toHaveLength(1);
    const owners = (
      await testDb.db
        .select()
        .from(courseMemberships)
        .where(eq(courseMemberships.courseId, courseId))
    ).filter((m) => m.owner);
    expect(owners).toHaveLength(1);
  });
});

describe('authority around a withdrawal', () => {
  /** Makes `person` an instructor of `classId` through an invitation, as the world does. */
  async function teach(
    ownerCookie: string,
    classId: string,
    person: { cookie: string },
    key: string,
  ) {
    const invite = await send(ownerCookie, 'POST', `/api/classes/${classId}/invites`, {
      kind: 'instructor',
      email: `${key}@example.test`,
    });
    expect(invite.status).toBe(200);
    const accepted = await send(person.cookie, 'POST', '/api/invitations/accept', {
      token: invite.body.code,
    });
    expect(accepted.status).toBe(200);
  }

  test('withdrawing ownership revokes the invitations issued under it, except where the person manages', async () => {
    const a = await newPerson('owner-a');
    const m = await newPerson('owner-m');
    const courseId = await createCourse(testDb.db, { title: 'Invitations', ownerId: a.id });
    const classes = [];
    for (const name of ['K', 'L']) {
      const created = await send(a.cookie, 'POST', `/api/courses/${courseId}/classes`, { name });
      classes.push(created.body.id as string);
    }
    const [k, l] = classes as [string, string];
    await teach(a.cookie, k, m, 'owner-m');
    await teach(a.cookie, l, m, 'owner-m');
    expect((await send(a.cookie, 'PUT', ownerUrl(courseId, m.id), { granted: true })).status).toBe(
      200,
    );
    const manage = `/api/classes/${l}/members/${m.id}/manage-members`;
    expect((await send(a.cookie, 'PUT', manage, { granted: true })).status).toBe(200);

    const issue = async (classId: string, email: string) =>
      (
        await send(m.cookie, 'POST', `/api/classes/${classId}/invites`, {
          kind: 'instructor',
          email,
        })
      ).body;
    const lapsing = await issue(k, 'guest-k@example.test');
    const kept = await issue(l, 'guest-l@example.test');

    expect((await send(a.cookie, 'PUT', ownerUrl(courseId, m.id), { granted: false })).status).toBe(
      200,
    );
    const guestK = await newPerson('guest-k');
    const guestL = await newPerson('guest-l');
    const takeK = await send(guestK.cookie, 'POST', '/api/invitations/accept', {
      token: lapsing.code,
    });
    expect(takeK.status).toBe(410);
    expect(takeK.body).toEqual({ error: 'invite_revoked' });
    // Where Marcus-like authority remains through manage_members, the invitation stands.
    expect(
      (await send(guestL.cookie, 'POST', '/api/invitations/accept', { token: kept.code })).status,
    ).toBe(200);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'invite.revoke'), eq(auditEvents.targetId, lapsing.id)));
    expect(event).toMatchObject({
      actorId: a.id,
      scopeKind: 'class',
      scopeId: k,
      after: { reason: 'issuer_lost_ownership' },
    });
  });

  test('a withdrawn owner whose request is already in flight cannot take ownership back', async () => {
    const a = await newPerson('race-a');
    const m = await newPerson('race-m');
    const friend = await newPerson('race-f');
    const courseId = await createCourse(testDb.db, { title: 'Stale', ownerId: a.id });
    for (let round = 0; round < 6; round++) {
      // Neither teaches, so withdrawal also removes their draft editing and the row: set both up again.
      for (const [userId, owner] of [
        [m.id, true],
        [friend.id, false],
      ] as const) {
        await testDb.db
          .insert(courseMemberships)
          .values({ courseId, userId, owner, editor: true })
          .onConflictDoUpdate({
            target: [courseMemberships.courseId, courseMemberships.userId],
            set: { owner, editor: true },
          });
      }
      const results = await Promise.all([
        send(a.cookie, 'PUT', ownerUrl(courseId, m.id), { granted: false }),
        send(m.cookie, 'PUT', ownerUrl(courseId, m.id), { granted: true }),
        send(m.cookie, 'PUT', ownerUrl(courseId, friend.id), { granted: true }),
        send(m.cookie, 'PUT', ownerUrl(courseId, m.id), { granted: true }),
      ]);
      expect(results.map((r) => r.status).every((status) => status < 500)).toBe(true);
      expect((await membership(courseId, m.id))?.owner ?? false, `round ${round}`).toBe(false);
      // A grant to the friend is legitimate when it ran before the withdrawal, so only the
      // withdrawn owner's own standing is fixed: nothing may bring it back.
    }
  });

  test('a former owner keeps draft editing only while teaching a class of the course', async () => {
    const draftsUrl = (courseId: string) => `/api/courses/${courseId}/drafts`;
    // A creator who never taught: withdrawn, they lose the drafts and nobody has to remove them.
    const creator = await newPerson('edit-creator');
    const heir = await newPerson('edit-heir');
    const courseId = await createCourse(testDb.db, { title: 'Hand over', ownerId: creator.id });
    const created = await send(creator.cookie, 'POST', `/api/courses/${courseId}/classes`, {
      name: 'K',
    });
    await teach(creator.cookie, created.body.id, heir, 'edit-heir');
    expect((await send(creator.cookie, 'GET', draftsUrl(courseId))).status).toBe(200);
    expect(
      (await send(creator.cookie, 'PUT', ownerUrl(courseId, heir.id), { granted: true })).status,
    ).toBe(200);
    expect(
      (await send(heir.cookie, 'PUT', ownerUrl(courseId, creator.id), { granted: false })).status,
    ).toBe(200);
    expect(await membership(courseId, creator.id)).toMatchObject({
      owner: false,
      editor: false,
      publisher: true,
    });
    expect((await send(creator.cookie, 'GET', draftsUrl(courseId))).status).toBe(403);
    const [dropped] = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'grant.editor'), eq(auditEvents.targetId, creator.id)));
    expect(dropped).toMatchObject({ actorId: heir.id, after: { editor: false } });

    // One who teaches a class of the course keeps editing after the same hand-over.
    const teacher = await newPerson('edit-teacher');
    const other = await newPerson('edit-other');
    const second = await createCourse(testDb.db, { title: 'Teaching owner', ownerId: teacher.id });
    const klass = await send(teacher.cookie, 'POST', `/api/courses/${second}/classes`, {
      name: 'L',
    });
    await teach(teacher.cookie, klass.body.id, teacher, 'edit-teacher');
    await teach(teacher.cookie, klass.body.id, other, 'edit-other');
    expect(
      (await send(teacher.cookie, 'PUT', ownerUrl(second, other.id), { granted: true })).status,
    ).toBe(200);
    expect(
      (await send(other.cookie, 'PUT', ownerUrl(second, teacher.id), { granted: false })).status,
    ).toBe(200);
    expect(await membership(second, teacher.id)).toMatchObject({ owner: false, editor: true });
    expect((await send(teacher.cookie, 'GET', draftsUrl(second))).status).toBe(200);
  });

  test('withdrawing a co-owner while they close their account never fails with a server error', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await newPerson(`dead-a${round}`);
      const b = await newPerson(`dead-b${round}`);
      const courseId = await createCourse(testDb.db, { title: 'Deadlock', ownerId: a.id });
      await testDb.db
        .insert(courseMemberships)
        .values({ courseId, userId: b.id, owner: true, editor: true });
      const [withdraw, close] = await Promise.all([
        send(a.cookie, 'PUT', ownerUrl(courseId, b.id), { granted: false }),
        send(b.cookie, 'POST', '/api/me/deactivate', { confirm: true }),
      ]);
      expect([withdraw.status, close.status], `round ${round}`).toEqual([200, 200]);
      expect((await membership(courseId, a.id))?.owner).toBe(true);
    }
  });
});
