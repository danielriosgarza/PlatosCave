import type { RouteContract } from '@parallax/contracts';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createSession, signInWithProof } from '../../src/db/auth/sessions';
import { applyRetention } from '../../src/db/lifecycle';
import {
  annotations,
  auditEvents,
  authSessions,
  classes,
  classInvites,
  classMemberships,
  connectors,
  courseMemberships,
  courses,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  posts,
  users,
} from '../../src/db/schema';
import {
  RETENTION,
  type RetentionPolicy,
  retentionPolicy,
  workMaintenance,
} from '../../src/jobs/maintenance';
import {
  buildWorld,
  cookieFor,
  ids,
  issueLiveInvites,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

/**
 * Archive and restore, annotation export, account deactivation and deletion, and the retention
 * job (§4, §8, §12, §13; plan item P4-09). No acceptance scenario is assigned to this item.
 */

const start = new Date('2026-10-01T09:00:00Z');
const day = 86_400_000;
let clock = start;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, start);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), {
    db: testDb.db,
    now: () => clock,
    mode: 'relay',
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

const classUrl = (classId: string) => `/api/classes/${classId}`;
const readingUrl = (classId: string) => `${classUrl(classId)}/resources/${ids.samplingReading}`;
const events = (action: string, targetId: string) =>
  testDb.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

const note = { kind: 'note', anchor: { kind: 'none' }, body: 'Why n − 1?' };
const strokes = [
  {
    tool: 'pen',
    color: '#1a73e8',
    width: 4,
    points: [
      [0.1, 0.1],
      [0.5, 0.4],
      [0.9, 0.2],
    ],
  },
];

describe('archive and restore of a class', () => {
  test('a manager archives a class, members keep reading and every write is refused', async () => {
    const mine = await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, note);
    expect(mine.status).toBe(200);

    // Instructors without the grant and members of another cohort cannot archive it.
    expect((await call('priya', 'POST', `${classUrl(ids.classA)}/archive`)).status).toBe(403);
    expect((await call('sam', 'POST', `${classUrl(ids.classA)}/archive`)).status).toBe(403);
    expect((await call('bea', 'POST', `${classUrl(ids.classA)}/archive`)).status).toBe(404);

    const archived = await call('noor', 'POST', `${classUrl(ids.classA)}/archive`);
    expect(archived).toEqual({ status: 200, body: { id: ids.classA, archived: true } });
    const [event] = await events('class.archive', ids.classA);
    expect(event).toMatchObject({ actorId: ids.noor, scopeKind: 'class', scopeId: ids.classA });
    // Archiving twice changes nothing and records nothing.
    expect(await call('noor', 'POST', `${classUrl(ids.classA)}/archive`)).toEqual({
      status: 409,
      body: { error: 'class_archived' },
    });
    expect(await events('class.archive', ids.classA)).toHaveLength(1);

    expect((await call('sam', 'GET', classUrl(ids.classA))).body).toMatchObject({ archived: true });
    const read = await call('sam', 'GET', `${readingUrl(ids.classA)}/annotations`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain('Why n');
    expect(await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, note)).toEqual({
      status: 409,
      body: { error: 'class_archived' },
    });

    const restored = await call('elena', 'POST', `${classUrl(ids.classA)}/restore`);
    expect(restored).toEqual({ status: 200, body: { id: ids.classA, archived: false } });
    expect(await events('class.restore', ids.classA)).toHaveLength(1);
    expect((await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, note)).status).toBe(
      200,
    );
    expect(await call('elena', 'POST', `${classUrl(ids.classA)}/restore`)).toEqual({
      status: 409,
      body: { error: 'not_archived' },
    });
  });

  test('an archived class still lets a manager end access, and its results export still reads', async () => {
    const invites = await issueLiveInvites(testDb.db, start);
    await testDb.db.insert(classMemberships).values({
      classId: ids.classA,
      userId: ids.olivia,
      role: 'student',
    });
    await testDb.db.update(classes).set({ archivedAt: start }).where(eq(classes.id, ids.classA));
    try {
      const [open] = await testDb.db
        .select()
        .from(classInvites)
        .where(and(eq(classInvites.classId, ids.classA), eq(classInvites.kind, 'enrolment')));
      const revoked = await call('noor', 'DELETE', `${classUrl(ids.classA)}/invites/${open?.id}`);
      expect(revoked.status).toBe(200);
      const removed = await call('noor', 'DELETE', `${classUrl(ids.classA)}/members/${ids.olivia}`);
      expect(removed.status).toBe(200);
      // The class refuses a new member by code, but never revokes access to what it holds.
      expect(
        (await call('olivia', 'POST', '/api/join', { code: invites.enrolmentCode })).status,
      ).toBe(409);
      const csv = await call('priya', 'POST', `${classUrl(ids.classA)}/exports/results`);
      expect(csv.status).toBe(201);
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classA));
    }
  });

  test('registerRoute refuses every class write of an archived class unless the route opts out', async () => {
    await testDb.db.update(classes).set({ archivedAt: start }).where(eq(classes.id, ids.classA));
    try {
      const writes = app.contracts.filter(
        (c) =>
          c.scope.kind === 'class' && c.method !== 'GET' && !c.allowWhenArchived && !c.websocket,
      );
      expect(writes.length).toBeGreaterThan(30);
      const who = (c: RouteContract): PersonName => {
        const scope = c.scope as { role: string; grant?: string };
        if (scope.grant) return 'noor';
        return scope.role === 'instructor' ? 'priya' : 'sam';
      };
      const wrong: string[] = [];
      for (const c of writes) {
        const params: Record<string, string> = {
          ...(c.examples.params as Record<string, string>),
          classId: ids.classA,
        };
        const url = c.path.replace(/:(\w+)/g, (_, k: string) => String(params[k]));
        const query = c.examples.query as Record<string, string> | undefined;
        const res = await app.inject({
          method: c.method,
          url: query ? `${url}?${new URLSearchParams(query)}` : url,
          headers: { cookie: world.cookie[who(c)] },
          ...(c.examples.body !== undefined && { payload: c.examples.body as object }),
        });
        const body = res.json();
        if (res.statusCode !== 409 || body.error !== 'class_archived') {
          wrong.push(`${c.method} ${c.path}: ${res.statusCode} ${JSON.stringify(body)}`);
        }
      }
      expect(wrong).toEqual([]);
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classA));
    }
  });
});

describe('archive and restore of a course', () => {
  test('an archived course keeps reads, refuses writes, and restores with its classes', async () => {
    expect((await call('marcus', 'POST', `/api/courses/${ids.statistics}/archive`)).status).toBe(
      403,
    );
    expect((await call('olivia', 'POST', `/api/courses/${ids.statistics}/archive`)).status).toBe(
      404,
    );
    const live = await issueLiveInvites(testDb.db, start, 'late@example.test');
    const archived = await call('elena', 'POST', `/api/courses/${ids.statistics}/archive`);
    expect(archived).toEqual({ status: 200, body: { id: ids.statistics, archived: true } });
    // Nobody joins a read-only class by code or invitation, whichever of the two is archived.
    const joined = await call('olivia', 'POST', '/api/join', { code: live.enrolmentCode });
    expect(joined).toMatchObject({ status: 409, body: { error: 'class_archived' } });
    expect(
      (await call('olivia', 'POST', '/api/invitations/accept', { token: live.instructorToken }))
        .status,
    ).not.toBe(200);
    expect(
      (
        await testDb.db
          .select()
          .from(classMemberships)
          .where(eq(classMemberships.userId, ids.olivia))
      ).length,
    ).toBe(0);
    expect(await events('course.archive', ids.statistics)).toHaveLength(1);

    // Its classes read but do not write, and a class cannot be reopened under an archived course.
    expect((await call('sam', 'GET', classUrl(ids.classA))).body).toMatchObject({ archived: true });
    expect((await call('bea', 'GET', classUrl(ids.classB))).body).toMatchObject({ archived: true });
    expect((await call('sam', 'GET', `${readingUrl(ids.classA)}/annotations`)).status).toBe(200);
    expect(await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, note)).toEqual({
      status: 409,
      body: { error: 'class_archived' },
    });
    expect(await call('noor', 'POST', `${classUrl(ids.classA)}/restore`)).toEqual({
      status: 409,
      body: { error: 'course_archived' },
    });
    // The draft stops taking edits and publications; editors still read it.
    const edit = await call('elena', 'POST', `/api/courses/${ids.statistics}/topics`, {
      title: 'Late topic',
    });
    expect(edit).toEqual({ status: 409, body: { error: 'course_archived' } });
    expect(await call('ines', 'POST', `/api/courses/${ids.statistics}/releases`, {})).toEqual({
      status: 409,
      body: { error: 'course_archived' },
    });
    const overview = await call('elena', 'GET', `/api/courses/${ids.statistics}/overview`);
    expect(overview.body).toMatchObject({ archived: true });
    expect(overview.body.classes.every((c: { archived: boolean }) => c.archived)).toBe(true);
    const cards = await call('sam', 'GET', '/api/courses');
    expect(cards.body.classes[0]).toMatchObject({ classId: ids.classA, archived: true });

    expect(await call('elena', 'POST', `/api/courses/${ids.statistics}/archive`)).toEqual({
      status: 409,
      body: { error: 'course_archived' },
    });
    const restored = await call('elena', 'POST', `/api/courses/${ids.statistics}/restore`);
    expect(restored).toEqual({ status: 200, body: { id: ids.statistics, archived: false } });
    expect(await events('course.restore', ids.statistics)).toHaveLength(1);
    expect(await call('elena', 'POST', `/api/courses/${ids.statistics}/restore`)).toEqual({
      status: 409,
      body: { error: 'not_archived' },
    });
    expect((await call('sam', 'GET', classUrl(ids.classA))).body).toMatchObject({
      archived: false,
    });
    expect((await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, note)).status).toBe(
      200,
    );
  });
});

describe('writes to an archived course', () => {
  test('registerRoute refuses every course write once the course is archived', async () => {
    await testDb.db
      .update(courses)
      .set({ archivedAt: start })
      .where(eq(courses.id, ids.statistics));
    try {
      const writes = app.contracts.filter(
        (c) =>
          c.scope.kind === 'course' && c.method !== 'GET' && !c.allowWhenArchived && !c.websocket,
      );
      expect(writes.length).toBeGreaterThan(8);
      const wrong: string[] = [];
      for (const c of writes) {
        const params: Record<string, string> = {
          ...(c.examples.params as Record<string, string>),
          courseId: ids.statistics,
        };
        const url = c.path.replace(/:(\w+)/g, (_, k: string) => String(params[k]));
        const res = await app.inject({
          method: c.method,
          url,
          headers: { cookie: world.cookie.elena },
          ...(c.examples.body !== undefined && { payload: c.examples.body as object }),
        });
        const body = res.json();
        if (res.statusCode !== 409 || body.error !== 'course_archived') {
          wrong.push(`${c.method} ${c.path}: ${res.statusCode} ${JSON.stringify(body)}`);
        }
      }
      expect(wrong).toEqual([]);
    } finally {
      await testDb.db
        .update(courses)
        .set({ archivedAt: null })
        .where(eq(courses.id, ids.statistics));
    }
  });
});

describe('annotation export', () => {
  test('exports only the caller’s own annotations of the class, with titles, references and SVG', async () => {
    const url = `${readingUrl(ids.classB)}/annotations`;
    const text = await call('bea', 'POST', url, { ...note, body: 'Beas note' });
    const figure = { kind: 'figure', figureId: 'fig-1', strokes };
    const sketch = await call('bea', 'POST', url, {
      kind: 'sketch',
      anchor: figure,
      body: 'My <curve> & more',
    });
    expect([text.status, sketch.status]).toEqual([200, 200]);
    // Another student's note, and another class's note of the same person, stay out.
    await call('priya', 'POST', url, { ...note, body: 'Priya studies here too' });
    await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, { ...note, body: 'Sams' });
    const question = await call('bea', 'POST', `${readingUrl(ids.classB)}/threads`, {
      audience: 'instructor',
      anchor: { kind: 'none' },
      body: 'Is n − 1 always right?',
    });
    expect(question.status).toBe(200);

    clock = new Date(start.getTime() + 60_000);
    const res = await call('bea', 'GET', `${classUrl(ids.classB)}/export/annotations`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      exportedAt: clock.toISOString(),
      class: { id: ids.classB },
      course: { id: ids.statistics, title: 'Statistical thinking' },
    });
    const bodies = res.body.annotations.map((a: { body: string }) => a.body).sort();
    expect(bodies).toEqual(['Beas note', 'My <curve> & more']);
    const exportedSketch = res.body.annotations.find((a: { kind: string }) => a.kind === 'sketch');
    expect(exportedSketch).toMatchObject({
      resourceTitle: expect.any(String),
      topicTitle: expect.any(String),
      source: { resourceId: ids.samplingReading, reference: 'figure fig-1', anchor: figure },
    });
    expect(exportedSketch.resourceTitle.length).toBeGreaterThan(0);
    const { svg, description } = exportedSketch.drawing;
    expect(description).toBe('My <curve> & more');
    expect(svg).toContain('<svg');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('My &#60;curve&#62; &#38; more');
    expect(svg).not.toContain('<curve>');
    expect(res.body.posts).toEqual([
      expect.objectContaining({
        threadId: question.body.id,
        audience: 'instructor',
        body: 'Is n − 1 always right?',
      }),
    ]);
    expect(
      res.body.annotations.find((a: { kind: string }) => a.kind === 'note').drawing,
    ).toBeNull();

    const [event] = await events('export.annotations', ids.bea);
    expect(event).toMatchObject({ actorId: ids.bea, scopeId: ids.classB });
    expect(event?.after).toEqual({ annotations: 2, posts: 1 });

    // A post an instructor removed from view stays hidden from its author in the export too.
    const postId = question.body.posts[0].id;
    const hidden = await call(
      'marcus',
      'POST',
      `${classUrl(ids.classB)}/posts/${postId}/moderate`,
      {
        reason: 'Off topic',
      },
    );
    expect(hidden.status).toBe(200);
    const after = await call('bea', 'GET', `${classUrl(ids.classB)}/export/annotations`);
    expect(after.body.posts).toEqual([expect.objectContaining({ id: postId, body: null })]);
  });

  test('a person outside the class gets 404, and an archived class still exports', async () => {
    expect((await call('sam', 'GET', `${classUrl(ids.classB)}/export/annotations`)).status).toBe(
      404,
    );
    expect((await call('elena', 'GET', `${classUrl(ids.classA)}/export/annotations`)).status).toBe(
      404,
    );
    await testDb.db.update(classes).set({ archivedAt: start }).where(eq(classes.id, ids.classA));
    try {
      const res = await call('sam', 'GET', `${classUrl(ids.classA)}/export/annotations`);
      expect(res.status).toBe(200);
      expect(res.body.annotations.length).toBeGreaterThan(0);
      expect(
        res.body.annotations.every((a: { body: string | null }) => a.body !== 'Beas note'),
      ).toBe(true);
    } finally {
      await testDb.db.update(classes).set({ archivedAt: null }).where(eq(classes.id, ids.classA));
    }
  });
});

const userRow = async (id: string) =>
  (await testDb.db.select().from(users).where(eq(users.id, id)))[0];

async function activeConnector(ownerUserId: string, fingerprint: string) {
  const [row] = await testDb.db
    .insert(connectors)
    .values({
      ownerUserId,
      name: 'Laptop',
      mode: 'personal',
      status: 'active',
      publicKey: Buffer.alloc(32, 7),
      fingerprint,
      os: 'linux',
      arch: 'amd64',
      version: '0.1.0',
      approvedAt: start,
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error('connector insert returned no row');
  return row.id;
}

describe('account deactivation and deletion', () => {
  test('refuses a stale sign-in, an unconfirmed request and a preview principal', async () => {
    const old = await createSession(testDb.db, ids.bea, {
      now: start,
      authTime: new Date(start.getTime() - 16 * 60_000),
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/api/me/delete',
      headers: { cookie: cookieFor(old.token) },
      payload: { confirm: true },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: 'recent_auth_required' });
    expect((await call('bea', 'POST', '/api/me/delete', { confirm: false })).status).toBe(400);
    for (const path of ['/api/me/delete', '/api/me/deactivate']) {
      expect(await call('previewB', 'POST', path, { confirm: true })).toEqual({
        status: 403,
        body: { error: 'forbidden' },
      });
    }
    expect((await userRow(ids.bea))?.deactivatedAt).toBeNull();
  });

  test('deactivation ends sessions, revokes connectors and closes sign-in, keeping the identity', async () => {
    const connectorId = await activeConnector(ids.priya, 'SHA256:deactivate');
    const res = await call('priya', 'POST', '/api/me/deactivate', { confirm: true });
    expect(res).toEqual({ status: 200, body: { deactivatedAt: clock.toISOString() } });

    expect((await call('priya', 'GET', '/api/me')).status).toBe(401);
    const [connector] = await testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(connector).toMatchObject({ status: 'revoked', revokedReason: 'account' });
    const row = await userRow(ids.priya);
    expect(row).toMatchObject({
      email: 'priya@example.test',
      name: 'Priya Nair',
      anonymisedAt: null,
    });
    expect(row?.deactivatedAt).not.toBeNull();
    const [event] = await events('account.deactivate', ids.priya);
    expect(event).toMatchObject({ actorId: ids.priya, scopeKind: 'user' });

    // A link for the address no longer signs in, and no new session exists afterwards.
    const signedIn = await signInWithProof(testDb.db, {
      consume: async () => ({ ok: true, email: 'priya@example.test', destination: '/' }),
      now: clock,
    });
    expect(signedIn.token).toBeUndefined();
    const live = await testDb.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, ids.priya));
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);
    // Her memberships stay for the organisation's records.
    const kept = await testDb.db
      .select()
      .from(classMemberships)
      .where(eq(classMemberships.userId, ids.priya));
    expect(kept.length).toBeGreaterThan(0);
  });

  test('the only active owner of a course, archived or not, cannot close the account', async () => {
    expect(await call('olivia', 'POST', '/api/me/deactivate', { confirm: true })).toEqual({
      status: 409,
      body: { error: 'owns_courses' },
    });
    expect((await userRow(ids.olivia))?.deactivatedAt).toBeNull();
    // Archiving does not lift it: nobody could restore the course afterwards.
    const archived = await call('olivia', 'POST', `/api/courses/${ids.linearModels}/archive`);
    expect(archived.status).toBe(200);
    expect(await call('olivia', 'POST', '/api/me/delete', { confirm: true })).toEqual({
      status: 409,
      body: { error: 'owns_courses' },
    });
    // A second active owner can restore it, so the first may leave.
    await testDb.db
      .insert(courseMemberships)
      .values({ courseId: ids.linearModels, userId: ids.ines, owner: true });
    const res = await call('olivia', 'POST', '/api/me/delete', { confirm: true });
    expect(res.status).toBe(200);
    expect((await call('ines', 'POST', `/api/courses/${ids.linearModels}/restore`)).status).toBe(
      200,
    );
  });

  test('deletion anonymises the identity, deletes private notes and keeps records under the pseudonym', async () => {
    const connectorId = await activeConnector(ids.sam, 'SHA256:delete');
    const mine = await call('sam', 'POST', `${readingUrl(ids.classA)}/annotations`, {
      ...note,
      body: 'Private to Sam',
    });
    expect(mine.status).toBe(200);
    const asked = await call('sam', 'POST', `${readingUrl(ids.classA)}/threads`, {
      audience: 'class',
      anchor: { kind: 'none' },
      body: 'Shared with the class',
    });
    expect(asked.status).toBe(200);
    const before = await testDb.db
      .select()
      .from(annotations)
      .where(eq(annotations.authorId, ids.sam));
    expect(before.length).toBeGreaterThan(0);
    const [copy] = await testDb.db
      .insert(notebookWorkingCopies)
      .values({
        classId: ids.classA,
        userId: ids.sam,
        sourceRevisionId: ids.samplingReadingV1,
      })
      .returning({ id: notebookWorkingCopies.id });
    await testDb.db.insert(notebookWorkingCopyRevisions).values({
      workingCopyId: copy?.id ?? '',
      revision: 1,
      classId: ids.classA,
      objectKey: 'classes/x/working-copies/y',
      sha256: 'a'.repeat(64),
      size: 10,
      source: 'server',
    });

    const res = await call('sam', 'POST', '/api/me/delete', { confirm: true });
    expect(res.status).toBe(200);
    expect((await call('sam', 'GET', '/api/me')).status).toBe(401);

    const row = await userRow(ids.sam);
    expect(row).toMatchObject({
      name: 'Former user',
      email: `deleted-${ids.sam}@anonymised.invalid`,
    });
    expect(row?.deactivatedAt).not.toBeNull();
    expect(row?.anonymisedAt).not.toBeNull();
    // Private annotations are gone; shared posts, memberships and audit rows remain.
    expect(
      await testDb.db.select().from(annotations).where(eq(annotations.authorId, ids.sam)),
    ).toEqual([]);
    // Unsubmitted working copies of notebooks go with them.
    expect(
      await testDb.db
        .select()
        .from(notebookWorkingCopies)
        .where(eq(notebookWorkingCopies.userId, ids.sam)),
    ).toEqual([]);
    expect(
      (await testDb.db.select().from(posts).where(eq(posts.authorId, ids.sam))).length,
    ).toBeGreaterThan(0);
    expect(
      (await testDb.db.select().from(classMemberships).where(eq(classMemberships.userId, ids.sam)))
        .length,
    ).toBeGreaterThan(0);
    const [connector] = await testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(connector).toMatchObject({ status: 'revoked', revokedReason: 'account' });
    const [event] = await events('account.delete', ids.sam);
    expect(event?.after).toEqual({ deactivated: true, anonymised: true });
    // The address is free again: a link for it creates a new, unrelated account.
    const again = await signInWithProof(testDb.db, {
      consume: async () => ({ ok: true, email: 'sam@example.test', destination: '/' }),
      now: clock,
    });
    expect(again.token).toBeDefined();
    const fresh = await testDb.db.select().from(users).where(eq(users.email, 'sam@example.test'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.id).not.toBe(ids.sam);
    // Class discussion now shows the pseudonym, never the old name.
    const thread = await call('noor', 'GET', `${readingUrl(ids.classA)}/threads`);
    expect(JSON.stringify(thread.body)).not.toContain('Sam');
  });
});

describe('deleting an invited instructor', () => {
  test('the address leaves invitations and audit rows, which keep their place under the pseudonym', async () => {
    const address = 'marcus@example.test';
    const mentions = async () =>
      (await testDb.db.select().from(auditEvents)).filter((e) =>
        JSON.stringify([e.before, e.after]).includes(address),
      );
    expect((await mentions()).length).toBeGreaterThan(0);
    const del = await call('marcus', 'POST', '/api/me/delete', { confirm: true });
    expect(del).toMatchObject({
      status: 200,
    });
    expect(await mentions()).toEqual([]);
    const pseudonym = `deleted-${ids.marcus}@anonymised.invalid`;
    const invites = await testDb.db.select().from(classInvites);
    expect(invites.some((i) => i.email === address)).toBe(false);
    expect(invites.some((i) => i.email === pseudonym)).toBe(true);
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'invite.create'));
    expect(JSON.stringify(events)).toContain(pseudonym);
  });
});

describe('retention job', () => {
  const policy = (p: Partial<RetentionPolicy>): RetentionPolicy => ({
    deactivatedGraceDays: null,
    auditEventDays: null,
    ...p,
  });

  test('with no period set it removes nothing', async () => {
    const before = (await testDb.db.select().from(auditEvents)).length;
    expect(
      await applyRetention(testDb.db, policy({}), new Date(start.getTime() + 900 * day)),
    ).toEqual({
      anonymised: 0,
      auditEventsDeleted: 0,
    });
    expect((await testDb.db.select().from(auditEvents)).length).toBe(before);
  });

  test('anonymises accounts deactivated longer than the grace period and prunes old audit events', async () => {
    // Priya was deactivated at `clock`; Noor six days later; only Priya is past a 30-day grace.
    await testDb.db
      .update(users)
      .set({ deactivatedAt: new Date(start.getTime() - 40 * day) })
      .where(eq(users.id, ids.priya));
    await testDb.db
      .update(users)
      .set({ deactivatedAt: new Date(start.getTime() - 6 * day) })
      .where(eq(users.id, ids.noor));
    await testDb.db
      .update(auditEvents)
      .set({ createdAt: new Date(start.getTime() - 400 * day) })
      .where(eq(auditEvents.action, 'grant.manage_members'));
    const stale = (await testDb.db.select().from(auditEvents)).filter(
      (e) => e.createdAt.getTime() < start.getTime() - 365 * day,
    ).length;
    expect(stale).toBeGreaterThan(0);

    const now = new Date(start.getTime() + day);
    const result = await applyRetention(
      testDb.db,
      policy({ deactivatedGraceDays: 30, auditEventDays: 365 }),
      now,
    );
    expect(result).toEqual({ anonymised: 1, auditEventsDeleted: stale });
    expect(await userRow(ids.priya)).toMatchObject({
      name: 'Former user',
      email: `deleted-${ids.priya}@anonymised.invalid`,
    });
    expect((await userRow(ids.noor))?.anonymisedAt).toBeNull();
    expect((await events('account.anonymise', ids.priya))[0]).toMatchObject({
      actorId: null,
      scopeKind: 'system',
    });
    // Running it again finds nothing more to do.
    expect(await applyRetention(testDb.db, policy({ deactivatedGraceDays: 30 }), now)).toEqual({
      anonymised: 0,
      auditEventsDeleted: 0,
    });
  });

  test('the maintenance worker schedules the retention queue only with an explicit policy', async () => {
    const run = async (retention?: RetentionPolicy) => {
      const queues: string[] = [];
      const boss = {
        createQueue: async () => {},
        schedule: async () => {},
        work: async (name: string) => void queues.push(name),
      } as unknown as PgBoss;
      const quiet = { info() {}, error() {}, warn() {} } as never;
      await workMaintenance(boss, testDb.db, quiet, retention);
      return queues;
    };
    expect(await run()).not.toContain(RETENTION);
    expect(await run(policy({ auditEventDays: 365 }))).toContain(RETENTION);
    // With every period unset the configuration yields no policy, so no queue is scheduled.
    expect(retentionPolicy({})).toBeUndefined();
    expect(retentionPolicy({ RETENTION_AUDIT_DAYS: 90 })).toEqual({
      deactivatedGraceDays: null,
      auditEventDays: 90,
    });
  });
});
