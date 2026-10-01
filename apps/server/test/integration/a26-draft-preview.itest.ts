import { sign } from '@fastify/cookie';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { PREVIEW_RETURN_COOKIE } from '../../src/auth/preview';
import { SESSION_COOKIE } from '../../src/auth/sessions';
import { DEV_SESSION_SECRET, loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { excludePreview } from '../../src/db/preview';
import {
  annotations,
  auditEvents,
  classes,
  classMemberships,
  courseMemberships,
  users,
} from '../../src/db/schema';
import { buildWorld, cookieFor, ids, type PersonName, type World } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const course = `/api/courses/${ids.statistics}`;
const editor = `/courses/${ids.statistics}/edit/${ids.sampling}`;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }), {
    db: testDb.db,
    now: () => now,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

async function request(cookie: string, method: Method, url: string, body?: object) {
  const res = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(body && { payload: body }),
  });
  const cookies = new Map(res.cookies.map((c) => [c.name, c]));
  return { status: res.statusCode, body: res.json(), cookies };
}

const call = (who: PersonName, method: Method, url: string, body?: object) =>
  request(world.cookie[who], method, url, body);

/** The Cookie header a browser holds after a response set (or cleared) `names`. */
const jar = (cookies: Map<string, { value: string }>, ...names: string[]) =>
  names
    .flatMap((name) => {
      const c = cookies.get(name);
      return c?.value ? [`${name}=${encodeURIComponent(c.value)}`] : [];
    })
    .join('; ');

/** Marcus starts a preview of class B from the Sampling editor; returns the browser's cookies. */
async function startAsMarcus() {
  const res = await call('marcus', 'POST', `${course}/preview`, {
    classId: ids.classB,
    topicId: ids.sampling,
  });
  expect(res.status).toBe(200);
  return { ...res, browser: jar(res.cookies, SESSION_COOKIE, PREVIEW_RETURN_COOKIE) };
}

const topicTitles = (body: { topics: { title: string }[] }) => body.topics.map((t) => t.title);

describe('A26 draft preview', () => {
  test('A26 an instructor previews the course draft as a student of a class they teach', async () => {
    const started = await startAsMarcus();
    expect(started.body).toMatchObject({
      classId: ids.classB,
      preview: { id: ids.previewB, name: 'Preview student' },
    });
    // The browser's session is now the preview principal's; the instructor's is kept aside.
    expect(started.cookies.get(SESSION_COOKIE)?.httpOnly).toBe(true);
    expect(started.cookies.get(PREVIEW_RETURN_COOKIE)).toMatchObject({
      httpOnly: true,
      path: '/api',
    });
    const me = await request(started.browser, 'GET', '/api/me');
    expect(me.body.user).toMatchObject({ id: ids.previewB, kind: 'preview' });
    expect(me.body.classes).toEqual([
      expect.objectContaining({ classId: ids.classB, role: 'student', isPreview: true }),
    ]);
    expect(me.body.courses).toEqual([]);

    // A draft edit shows in the preview, with the class's student rules (hidden stays hidden).
    const renamed = await call('marcus', 'PATCH', `${course}/topics/${ids.sampling}`, {
      expectedRevision: 1,
      title: 'Sampling (draft)',
    });
    expect(renamed.status).toBe(200);
    const preview = await request(started.browser, 'GET', `/api/classes/${ids.classB}/topics`);
    expect(preview.status).toBe(200);
    expect(preview.body.release).toBeNull();
    expect(preview.body.cohort).toBe('Autumn 2026 B');
    expect(topicTitles(preview.body)).toEqual(['Sampling (draft)', 'Estimation']);
    expect(preview.body.topics[1]).toMatchObject({ state: 'locked' });
    const release = await request(started.browser, 'GET', `/api/classes/${ids.classB}/release`);
    expect(
      release.body.topics.flatMap((t: { resources: { title: string }[] }) =>
        t.resources.map((r) => r.title),
      ),
    ).toEqual(['Why samples vary', 'Sampling quiz']);

    // Editing and previewing never changed the release class B adopted.
    const bea = await call('bea', 'GET', `/api/classes/${ids.classB}/topics`);
    expect(bea.body.release).toEqual({ id: ids.releaseV1, version: 1 });
    expect(topicTitles(bea.body)).toEqual(['Sampling', 'Estimation']);
    const [classB] = await testDb.db
      .select({ releaseId: classes.releaseId })
      .from(classes)
      .where(eq(classes.id, ids.classB));
    expect(classB?.releaseId).toBe(ids.releaseV1);

    await call('marcus', 'PATCH', `${course}/topics/${ids.sampling}`, {
      expectedRevision: 2,
      title: 'Sampling',
    });
  });

  test('A26 leaving draft preview returns to the instructor editor with their own session', async () => {
    const started = await startAsMarcus();
    const exit = await request(started.browser, 'POST', '/api/preview/exit');
    expect(exit.status).toBe(200);
    expect(exit.body).toEqual({ restored: true, returnTo: editor });
    // The instructor's own session cookie is back; the kept copy is cleared.
    const restored = jar(exit.cookies, SESSION_COOKIE);
    expect(restored).toBe(world.cookie.marcus);
    expect(exit.cookies.get(PREVIEW_RETURN_COOKIE)?.value).toBe('');
    expect((await request(restored, 'GET', '/api/me')).body.user).toMatchObject({
      id: ids.marcus,
      kind: 'user',
    });
    // The preview session is over.
    expect((await request(started.browser, 'GET', '/api/me')).status).toBe(401);
  });

  test('A26 leaving the preview never hands back a session the preview owner does not hold', async () => {
    const started = await startAsMarcus();
    const preview = jar(started.cookies, SESSION_COOKIE);
    // A kept-session cookie naming someone else's session (Priya's) is not honoured.
    const { token } = await createSession(testDb.db, ids.priya, { now });
    const forged = Buffer.from(JSON.stringify({ token, courseId: ids.statistics })).toString(
      'base64url',
    );
    const other = `${PREVIEW_RETURN_COOKIE}=${encodeURIComponent(sign(forged, DEV_SESSION_SECRET))}`;
    const exit = await request(`${preview}; ${other}`, 'POST', '/api/preview/exit');
    expect(exit.body).toEqual({ restored: false, returnTo: `/courses/${ids.statistics}/edit` });
    expect(exit.cookies.get(SESSION_COOKIE)?.value).toBe('');

    // Without a kept session the preview still ends and the browser is signed out.
    const again = await startAsMarcus();
    const bare = await request(jar(again.cookies, SESSION_COOKIE), 'POST', '/api/preview/exit');
    expect(bare.body).toEqual({ restored: false, returnTo: '/courses' });
    expect((await request(jar(again.cookies, SESSION_COOKIE), 'GET', '/api/me')).status).toBe(401);

    // Only a preview session can leave a preview.
    expect((await call('marcus', 'POST', '/api/preview/exit')).body).toEqual({
      error: 'not_previewing',
    });
  });

  test('A26 signing out during a preview ends the kept instructor session too', async () => {
    const { token } = await createSession(testDb.db, ids.marcus, { now });
    const marcus = cookieFor(token);
    const res = await request(marcus, 'POST', `${course}/preview`, { classId: ids.classB });
    const browser = jar(res.cookies, SESSION_COOKIE, PREVIEW_RETURN_COOKIE);
    const out = await request(browser, 'POST', '/api/auth/signout');
    expect(out.status).toBe(200);
    expect(out.cookies.get(PREVIEW_RETURN_COOKIE)?.value).toBe('');
    expect((await request(marcus, 'GET', '/api/me')).status).toBe(401);
    expect((await request(browser, 'GET', '/api/me')).status).toBe(401);
  });

  test('A26 preview is refused for classes the caller does not teach and topics outside the draft', async () => {
    const refusals: [PersonName, object][] = [
      // Elena owns the course but teaches no class; Marcus does not teach class A.
      ['elena', { classId: ids.classB }],
      ['marcus', { classId: ids.classA }],
      // A topic must be a topic of this course's draft.
      ['marcus', { classId: ids.classB, topicId: ids.classA }],
    ];
    for (const [who, body] of refusals) {
      const res = await call(who, 'POST', `${course}/preview`, body);
      expect(res.status, `${who} ${JSON.stringify(body)}`).toBe(404);
      expect(res.cookies.has(SESSION_COOKIE)).toBe(false);
    }
    // A publisher without editing permission cannot preview the draft.
    expect((await call('ines', 'POST', `${course}/preview`, { classId: ids.classB })).status).toBe(
      403,
    );
    // Starting again reuses the class's one preview principal and ends its earlier sessions.
    const first = await startAsMarcus();
    await startAsMarcus();
    expect((await request(first.browser, 'GET', '/api/me')).status).toBe(401);
    const principals = await testDb.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.ownerUserId, ids.marcus), eq(users.kind, 'preview')));
    expect(principals).toEqual([{ id: ids.previewB }]);
  });

  test('A26 preview writes stay under the preview principal and out of review and export', async () => {
    const started = await startAsMarcus();
    const note = await request(
      started.browser,
      'POST',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/annotations`,
      { kind: 'note', anchor: { kind: 'none' }, body: 'Preview note.' },
    );
    expect(note.status).toBe(200);
    const [row] = await testDb.db
      .select()
      .from(annotations)
      .where(eq(annotations.id, note.body.id));
    expect(row).toMatchObject({ authorId: ids.previewB, classId: ids.classB });
    // The review/export hook drops the preview principal's rows.
    const reviewed = await testDb.db
      .select({ id: annotations.id })
      .from(annotations)
      .where(excludePreview(annotations.authorId));
    expect(reviewed.map((r) => r.id)).not.toContain(note.body.id);
    // Class B's real student does not see it.
    const bea = await call(
      'bea',
      'GET',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/annotations`,
    );
    expect(JSON.stringify(bea.body)).not.toContain(note.body.id);
  });

  test('A26 a preview ends when its owner can no longer edit the course draft', async () => {
    const started = await startAsMarcus();
    const topics = `/api/classes/${ids.classB}/topics`;
    expect((await request(started.browser, 'GET', topics)).status).toBe(200);
    await testDb.db
      .update(courseMemberships)
      .set({ editor: false })
      .where(
        and(
          eq(courseMemberships.courseId, ids.statistics),
          eq(courseMemberships.userId, ids.marcus),
        ),
      );
    try {
      expect((await request(started.browser, 'GET', topics)).status).toBe(404);
    } finally {
      await testDb.db
        .update(courseMemberships)
        .set({ editor: true })
        .where(
          and(
            eq(courseMemberships.courseId, ids.statistics),
            eq(courseMemberships.userId, ids.marcus),
          ),
        );
    }
    // The preview membership itself is untouched and audited at creation only.
    const [membership] = await testDb.db
      .select({ isPreview: classMemberships.isPreview })
      .from(classMemberships)
      .where(eq(classMemberships.userId, ids.previewB));
    expect(membership).toEqual({ isPreview: true });
    const created = await testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, ids.previewB), eq(auditEvents.action, 'preview.create')));
    expect(created).toHaveLength(1);
  });
});
