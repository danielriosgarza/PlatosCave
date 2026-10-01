import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { userForVerifiedEmail } from '../../src/db/auth/accounts';
import { createSession } from '../../src/db/auth/sessions';
import { auditEvents, classInvites, classMemberships } from '../../src/db/schema';
import { buildWorld, cookieFor, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
/** Session cookies of accounts created during the tests, by email. */
const newcomers: Record<string, string> = {};

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = async (cookie: string, method: Method, url: string, payload?: object) => {
  const res = await app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
  return { status: res.statusCode, body: res.json() };
};
const as = (who: PersonName) => world.cookie[who];

/** A signed-in account that holds no membership yet, as after a first sign-in. */
async function newcomer(email: string): Promise<string> {
  const existing = newcomers[email];
  if (existing) return existing;
  const userId = await userForVerifiedEmail(testDb.db, email);
  const { token } = await createSession(testDb.db, userId, { now });
  newcomers[email] = cookieFor(token);
  return newcomers[email];
}

const issue = (who: string, classId: string, body: object) =>
  call(who, 'POST', `/api/classes/${classId}/invites`, body);
const join = (who: string, code: string) => call(who, 'POST', '/api/join', { code });
const accept = (who: string, token: string) =>
  call(who, 'POST', '/api/invitations/accept', { token });
const me = async (who: string) => (await call(who, 'GET', '/api/me')).body;

describe('class creation', () => {
  test('A01 only the course owner creates a class; it is recorded in the audit log', async () => {
    const created = await call(as('elena'), 'POST', `/api/courses/${ids.statistics}/classes`, {
      name: 'Spring 2027',
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ courseId: ids.statistics, name: 'Spring 2027' });
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'class.create'), eq(auditEvents.targetId, created.body.id)),
      );
    expect(event).toMatchObject({ actorId: ids.elena, scopeId: ids.statistics });

    const url = `/api/courses/${ids.statistics}/classes`;
    expect((await call(as('marcus'), 'POST', url, { name: 'x' })).status).toBe(403);
    expect((await call(as('ines'), 'POST', url, { name: 'x' })).status).toBe(403);
    expect((await call(as('sam'), 'POST', url, { name: 'x' })).status).toBe(404);
  });
});

describe('enrolment codes', () => {
  test('A02 an enrolment code only ever creates a student membership', async () => {
    const code = await issue(as('elena'), ids.classA, { kind: 'enrolment' });
    expect(code.status).toBe(200);
    expect(code.body.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const lena = await newcomer('lena@example.test');
    const joined = await join(lena, code.body.code.toLowerCase().replace('-', ' '));
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({
      classId: ids.classA,
      className: 'Autumn 2026 A',
      courseTitle: 'Statistical thinking',
      role: 'student',
      alreadyMember: false,
    });
    const view = await me(lena);
    expect(view.classes).toEqual([
      expect.objectContaining({ classId: ids.classA, role: 'student', manageMembers: false }),
    ]);
    expect(view.courses).toEqual([]);
    expect((await call(lena, 'GET', `/api/classes/${ids.classA}/releases`)).status).toBe(403);
    expect((await call(lena, 'GET', `/api/classes/${ids.classA}/members`)).status).toBe(403);

    // An instructor who reuses a code keeps their role; the code is not used up.
    const again = await join(as('priya'), code.body.code);
    expect(again.body).toMatchObject({ role: 'instructor', alreadyMember: true });
    const [row] = await testDb.db
      .select({ useCount: classInvites.useCount })
      .from(classInvites)
      .where(eq(classInvites.id, code.body.id));
    expect(row?.useCount).toBe(1);
  });

  test('A02 instructor invitation cannot come from a code, nor a code from an invitation', async () => {
    const code = await issue(as('elena'), ids.classA, { kind: 'enrolment' });
    const invite = await issue(as('elena'), ids.classA, {
      kind: 'instructor',
      email: 'omar@example.test',
    });
    const omar = await newcomer('omar@example.test');
    // An enrolment code presented as an instructor invitation is unknown there.
    expect(await accept(omar, code.body.code)).toEqual({
      status: 404,
      body: { error: 'invite_not_found' },
    });
    // An invitation token presented as an enrolment code is unknown too.
    expect(await join(omar, invite.body.code)).toEqual({
      status: 404,
      body: { error: 'invite_not_found' },
    });
    expect((await me(omar)).classes).toEqual([]);
    // Neither students nor instructors without the grant can issue invitations.
    for (const who of ['sam', 'priya', 'marcus'] as const) {
      const res = await issue(as(who), ids.classA, { kind: 'instructor', email: 'x@example.test' });
      expect(res.status, who).toBe(who === 'marcus' ? 404 : 403);
    }
  });

  test('A01 expired, full and revoked codes are refused with their cause', async () => {
    const one = await issue(as('noor'), ids.classA, { kind: 'enrolment', maxUses: 1 });
    expect(one.status).toBe(200);
    expect((await join(await newcomer('first@example.test'), one.body.code)).status).toBe(200);
    expect(await join(await newcomer('second@example.test'), one.body.code)).toEqual({
      status: 409,
      body: { error: 'invite_full' },
    });

    const expiring = await issue(as('elena'), ids.classA, {
      kind: 'enrolment',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await testDb.db
      .update(classInvites)
      .set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(classInvites.id, expiring.body.id));
    expect(await join(await newcomer('third@example.test'), expiring.body.code)).toEqual({
      status: 410,
      body: { error: 'invite_expired' },
    });

    const revoked = await issue(as('elena'), ids.classA, { kind: 'enrolment' });
    await testDb.db
      .update(classInvites)
      .set({ revokedAt: now })
      .where(eq(classInvites.id, revoked.body.id));
    expect((await join(await newcomer('third@example.test'), revoked.body.code)).body).toEqual({
      error: 'invite_revoked',
    });
    expect(await join(await newcomer('third@example.test'), 'NOPE2-NOPE3')).toEqual({
      status: 404,
      body: { error: 'invite_not_found' },
    });
    expect((await me(await newcomer('third@example.test'))).classes).toEqual([]);

    const past = await issue(as('elena'), ids.classA, {
      kind: 'enrolment',
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    expect(past).toEqual({ status: 400, body: { error: 'expiry_in_past' } });
  });

  test('A01 concurrent joins never exceed a code’s capacity', async () => {
    const code = await issue(as('elena'), ids.classA, { kind: 'enrolment', maxUses: 2 });
    const people = await Promise.all([1, 2, 3, 4, 5].map((n) => newcomer(`race${n}@example.test`)));
    const results = await Promise.all(people.map((p) => join(p, code.body.code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.body.error === 'invite_full')).toHaveLength(3);
  });

  test('A01 one account joining twice at once gets one membership and no error', async () => {
    const first = await issue(as('elena'), ids.classB, { kind: 'enrolment' });
    const second = await issue(as('elena'), ids.classB, { kind: 'enrolment' });
    const twice = await newcomer('twice@example.test');
    const results = await Promise.all([
      join(twice, first.body.code),
      join(twice, second.body.code),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.alreadyMember).sort()).toEqual([false, true]);
    const used = await testDb.db
      .select({ useCount: classInvites.useCount })
      .from(classInvites)
      .where(inArray(classInvites.id, [first.body.id, second.body.id]));
    expect(used.reduce((n, r) => n + r.useCount, 0)).toBe(1);
  });

  test('A01 a preview principal cannot join a class with a code', async () => {
    const code = await issue(as('elena'), ids.classA, { kind: 'enrolment' });
    expect((await join(as('previewB'), code.body.code)).status).toBe(404);
    const rows = await testDb.db
      .select()
      .from(classMemberships)
      .where(
        and(eq(classMemberships.userId, ids.previewB), eq(classMemberships.classId, ids.classA)),
      );
    expect(rows).toEqual([]);
  });
});

describe('instructor invitations', () => {
  test('A02 an invitation grants class instructor and draft editing, nothing more', async () => {
    const invite = await issue(as('noor'), ids.classA, {
      kind: 'instructor',
      email: 'Kofi@Example.test',
    });
    expect(invite.status).toBe(200);
    expect(invite.body).toMatchObject({
      kind: 'instructor',
      email: 'kofi@example.test',
      maxUses: 1,
    });
    expect(Date.parse(invite.body.expiresAt)).toBe(now.getTime() + 7 * 24 * 60 * 60_000);

    const noExpiry = await issue(as('noor'), ids.classA, {
      kind: 'instructor',
      email: 'kofi@example.test',
      expiresAt: null,
    });
    expect(noExpiry.status).toBe(400);

    const intruder = await newcomer('intruder@example.test');
    expect(await accept(intruder, invite.body.code)).toEqual({
      status: 403,
      body: { error: 'invite_other_account' },
    });

    const kofi = await newcomer('kofi@example.test');
    const accepted = await accept(kofi, invite.body.code);
    expect(accepted.body).toMatchObject({ classId: ids.classA, role: 'instructor' });
    const view = await me(kofi);
    expect(view.classes).toEqual([
      expect.objectContaining({ classId: ids.classA, role: 'instructor', manageMembers: false }),
    ]);
    expect(view.courses).toEqual([
      expect.objectContaining({
        courseId: ids.statistics,
        owner: false,
        editor: true,
        publisher: false,
      }),
    ]);
    expect((await call(kofi, 'GET', `/api/classes/${ids.classA}/releases`)).status).toBe(200);
    expect((await call(kofi, 'POST', `/api/courses/${ids.statistics}/releases`)).status).toBe(403);
    expect((await call(kofi, 'GET', `/api/classes/${ids.classA}/members`)).status).toBe(403);
    expect((await call(kofi, 'GET', `/api/classes/${ids.classB}`)).status).toBe(404);

    // Single use: nobody else can redeem it, and redeeming twice changes nothing.
    expect((await accept(kofi, invite.body.code)).body).toMatchObject({ alreadyMember: true });
  });

  test('A02 a student of the class cannot be upgraded through an invitation', async () => {
    const invite = await issue(as('elena'), ids.classB, {
      kind: 'instructor',
      email: 'bea@example.test',
    });
    expect(await accept(as('bea'), invite.body.code)).toEqual({
      status: 409,
      body: { error: 'already_member' },
    });
    expect((await call(as('bea'), 'GET', `/api/classes/${ids.classB}`)).body.role).toBe('student');
  });
});

describe('grants, removal and recent sign-in', () => {
  const grantUrl = (classId: string, userId: string) =>
    `/api/classes/${classId}/members/${userId}/manage-members`;
  const publisherUrl = (userId: string) =>
    `/api/courses/${ids.statistics}/members/${userId}/publisher`;

  test('A01 sensitive membership changes need a sign-in from the last 15 minutes', async () => {
    const stale = await createSession(testDb.db, ids.elena, {
      now,
      authTime: new Date(now.getTime() - 16 * 60_000),
    });
    const old = cookieFor(stale.token);
    for (const [method, url, body] of [
      ['PUT', grantUrl(ids.classA, ids.priya), { granted: true }],
      ['DELETE', `/api/classes/${ids.classA}/members/${ids.sam}`, undefined],
      ['PUT', publisherUrl(ids.priya), { granted: true }],
      ['POST', `/api/classes/${ids.classA}/invites`, { kind: 'enrolment' }],
    ] as const) {
      const res = await call(old, method, url, body);
      expect(res.status, url).toBe(401);
      expect(res.body.code).toBe('recent_auth_required');
    }
    const view = await me(as('priya'));
    expect(view.courses[0]).toMatchObject({ publisher: false });
    expect(view.classes[0]).toMatchObject({ classId: ids.classA, manageMembers: false });
    expect((await call(as('sam'), 'GET', `/api/classes/${ids.classA}`)).status).toBe(200);
  });

  test('A02 manage_members is granted per class by the owner or a delegate, and revoked', async () => {
    expect(
      (await call(as('noor'), 'PUT', grantUrl(ids.classA, ids.priya), { granted: true })).body,
    ).toEqual({ userId: ids.priya, manageMembers: true });
    expect((await call(as('priya'), 'GET', `/api/classes/${ids.classA}/members`)).status).toBe(200);
    // The grant is for class A only; in class B Priya is a student.
    expect((await call(as('priya'), 'GET', `/api/classes/${ids.classB}/members`)).status).toBe(403);

    const list = (await call(as('elena'), 'GET', `/api/classes/${ids.classA}/members`)).body;
    expect(list.members).toContainEqual(
      expect.objectContaining({ userId: ids.priya, role: 'instructor', manageMembers: true }),
    );
    expect(list.invites.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toMatch(/codeHash|"code"/);

    expect(
      (await call(as('elena'), 'PUT', grantUrl(ids.classA, ids.priya), { granted: false })).status,
    ).toBe(200);
    expect((await call(as('priya'), 'GET', `/api/classes/${ids.classA}/members`)).status).toBe(403);

    expect(
      await call(as('elena'), 'PUT', grantUrl(ids.classA, ids.sam), { granted: true }),
    ).toEqual({
      status: 409,
      body: { error: 'not_instructor' },
    });
    expect(
      (await call(as('elena'), 'PUT', grantUrl(ids.classA, ids.bea), { granted: true })).status,
    ).toBe(404);
    expect(
      (await call(as('elena'), 'PUT', grantUrl(ids.classB, ids.previewB), { granted: true }))
        .status,
    ).toBe(404);
  });

  test('A02 only the course owner grants and revokes publishing', async () => {
    expect(
      (await call(as('elena'), 'PUT', publisherUrl(ids.marcus), { granted: true })).status,
    ).toBe(200);
    expect((await me(as('marcus'))).courses[0]).toMatchObject({ editor: true, publisher: true });
    expect(
      (await call(as('marcus'), 'GET', `/api/courses/${ids.statistics}/releases/validation`))
        .status,
    ).toBe(200);
    expect(
      (await call(as('elena'), 'PUT', publisherUrl(ids.marcus), { granted: false })).status,
    ).toBe(200);
    expect((await me(as('marcus'))).courses[0]).toMatchObject({ editor: true, publisher: false });

    // A publisher-only member's last grant going away ends the course membership.
    expect(
      (await call(as('elena'), 'PUT', publisherUrl(ids.ines), { granted: false })).status,
    ).toBe(200);
    expect((await me(as('ines'))).courses).toEqual([]);
    expect((await call(as('elena'), 'PUT', publisherUrl(ids.ines), { granted: true })).status).toBe(
      200,
    );
    expect((await me(as('ines'))).courses[0]).toMatchObject({ editor: false, publisher: true });

    expect((await call(as('noor'), 'PUT', publisherUrl(ids.priya), { granted: true })).status).toBe(
      403,
    );
    expect((await call(as('ines'), 'PUT', publisherUrl(ids.priya), { granted: true })).status).toBe(
      403,
    );
    expect(await call(as('elena'), 'PUT', publisherUrl(ids.elena), { granted: false })).toEqual({
      status: 409,
      body: { error: 'owner' },
    });
    expect(
      (await call(as('elena'), 'PUT', publisherUrl(ids.previewB), { granted: true })).status,
    ).toBe(404);
  });

  test('A02 removing one membership leaves the person’s other context intact', async () => {
    // Priya teaches A and studies in B: removing her from B keeps her teaching A.
    expect(
      (await call(as('marcus'), 'DELETE', `/api/classes/${ids.classB}/members/${ids.priya}`))
        .status,
    ).toBe(403);
    expect(
      (await call(as('elena'), 'DELETE', `/api/classes/${ids.classB}/members/${ids.priya}`)).body,
    ).toEqual({ removed: true });
    expect((await call(as('priya'), 'GET', `/api/classes/${ids.classB}`)).status).toBe(404);
    const view = await me(as('priya'));
    expect(view.classes.map((c: { classId: string; role: string }) => [c.classId, c.role])).toEqual(
      [[ids.classA, 'instructor']],
    );
    expect(view.courses[0]).toMatchObject({ editor: true });
    expect(
      (await call(as('elena'), 'DELETE', `/api/classes/${ids.classB}/members/${ids.priya}`)).status,
    ).toBe(404);
  });

  test('A01 a removed instructor loses the class, their preview and draft editing', async () => {
    expect((await call(as('marcus'), 'GET', `/api/classes/${ids.classB}`)).status).toBe(200);
    expect(
      (await call(as('elena'), 'DELETE', `/api/classes/${ids.classB}/members/${ids.marcus}`))
        .status,
    ).toBe(200);
    expect((await call(as('marcus'), 'GET', `/api/classes/${ids.classB}`)).status).toBe(404);
    // Marcus's preview principal loses its membership and its sessions.
    expect((await call(as('previewB'), 'GET', `/api/classes/${ids.classB}`)).status).toBe(401);
    expect((await call(as('previewB'), 'GET', '/api/me')).status).toBe(401);
    expect((await call(as('marcus'), 'GET', `/api/courses/${ids.statistics}/drafts`)).status).toBe(
      404,
    );
    expect((await me(as('marcus'))).courses).toEqual([]);
  });

  test('A01 a grant change that changes nothing is not recorded', async () => {
    const count = async () => (await testDb.db.select().from(auditEvents)).length;
    const before = await count();
    const noop = await call(as('elena'), 'PUT', publisherUrl(ids.sam), { granted: false });
    expect(noop).toEqual({ status: 200, body: { userId: ids.sam, publisher: false } });
    const same = await call(as('elena'), 'PUT', grantUrl(ids.classA, ids.noor), { granted: true });
    expect(same.status).toBe(200);
    expect(await count()).toBe(before);
    expect((await me(as('sam'))).courses).toEqual([]);
  });

  test('A01 every membership change is recorded in audit_events', async () => {
    const rows = await testDb.db
      .select({
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        targetId: auditEvents.targetId,
      })
      .from(auditEvents);
    const actions = new Set(rows.map((r) => r.action));
    for (const action of [
      'class.create',
      'invite.create',
      'membership.add',
      'membership.remove',
      'grant.manage_members',
      'grant.publisher',
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(rows).toContainEqual({
      action: 'membership.remove',
      actorId: ids.elena,
      targetId: ids.marcus,
    });
    expect(rows).toContainEqual({
      action: 'grant.manage_members',
      actorId: ids.noor,
      targetId: ids.priya,
    });
  });
});

describe('fixture routes', () => {
  test('A01 are absent unless TEST_ROUTES=1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/signin-as',
      payload: { email: 'sam@example.test' },
    });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/test/world' })).statusCode).toBe(404);
  });

  test('A01 with TEST_ROUTES=1 sign in as anyone and report the world', async () => {
    const fixtures = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', TEST_ROUTES: '1' }),
      { db: testDb.db, now: () => now },
    );
    try {
      const worldRes = await fixtures.inject({ method: 'POST', url: '/api/test/world' });
      expect(worldRes.json()).toMatchObject({ created: false, ids: { classA: ids.classA } });
      const res = await fixtures.inject({
        method: 'POST',
        url: '/api/test/signin-as',
        payload: { email: 'sam@example.test', authenticatedMinutesAgo: 20 },
      });
      expect(res.json()).toEqual({ userId: ids.sam });
      const cookie = res.cookies.find((c) => c.name === 'pc_session');
      expect(cookie?.httpOnly).toBe(true);
      const meRes = await fixtures.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { pc_session: cookie?.value ?? '' },
      });
      expect(meRes.json().user.id).toBe(ids.sam);
    } finally {
      await fixtures.close();
    }
  });
});
