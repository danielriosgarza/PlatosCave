import { createHash } from 'node:crypto';
import { sign } from '@fastify/cookie';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { PREVIEW_RETURN_COOKIE } from '../../src/auth/preview';
import { SESSION_COOKIE } from '../../src/auth/sessions';
import { DEV_RUNNER_RUNTIMES, DEV_SESSION_SECRET, loadConfig } from '../../src/config';
import { createSession } from '../../src/db/auth/sessions';
import { adoptRelease } from '../../src/db/content/adoption';
import { createResource } from '../../src/db/content/drafts';
import { publishRelease } from '../../src/db/content/releases';
import { excludePreview, PREVIEW_SESSION_TTL_MS } from '../../src/db/preview';
import {
  annotations,
  auditEvents,
  classes,
  classMemberships,
  courseMemberships,
  resourceRevisions,
  resources,
  storageObjects,
  threads,
  topics,
  users,
} from '../../src/db/schema';
import {
  asClassScope,
  asCourseScope,
  buildWorld,
  cookieFor,
  ids,
  type PersonName,
  type World,
} from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

const now = new Date('2026-10-01T09:00:00Z');
const course = `/api/courses/${ids.statistics}`;
const editor = `/courses/${ids.statistics}/edit/${ids.sampling}`;

let testDb: TestDatabase;
let app: FastifyInstance;
let world: World;
let clock = now;

beforeAll(async () => {
  testDb = await createTestDatabase();
  world = await buildWorld(testDb.db, now);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }), {
    db: testDb.db,
    now: () => clock,
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
      // Opened as the preview student sees the topic: its first tab with material.
      landing: `/classes/${ids.classB}/topics/${ids.sampling}/reading`,
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
    // A shared thread is stamped `is_preview`, so the review/export hook drops it.
    const thread = await request(
      started.browser,
      'POST',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/threads`,
      { audience: 'class', anchor: { kind: 'none' }, body: 'Preview question.' },
    );
    expect(thread.status).toBe(200);
    const reviewed = await testDb.db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.classId, ids.classB), excludePreview(threads)));
    expect(reviewed.map((r) => r.id)).not.toContain(thread.body.id);
    // Class B's real student does not see it.
    const bea = await call(
      'bea',
      'GET',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/annotations`,
    );
    expect(JSON.stringify(bea.body)).not.toContain(note.body.id);
    expect(JSON.stringify(bea.body)).not.toContain(thread.body.id);
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
  test('A26 an ended preview still returns the instructor session; an exit with no cookies is refused', async () => {
    // Replaced by a later start: the first browser's preview session is revoked.
    const first = await startAsMarcus();
    await startAsMarcus();
    const replaced = await request(first.browser, 'POST', '/api/preview/exit');
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ restored: true, returnTo: editor });
    expect(jar(replaced.cookies, SESSION_COOKIE)).toBe(world.cookie.marcus);
    expect(replaced.cookies.get(PREVIEW_RETURN_COOKIE)?.value).toBe('');

    // Expired: the preview session lasts 8 h, the kept instructor session longer.
    const expired = await startAsMarcus();
    clock = new Date(now.getTime() + PREVIEW_SESSION_TTL_MS + 60_000);
    try {
      expect((await request(expired.browser, 'GET', '/api/me')).status).toBe(401);
      const exit = await request(expired.browser, 'POST', '/api/preview/exit');
      expect(exit.body).toEqual({ restored: true, returnTo: editor });
      const me = await request(jar(exit.cookies, SESSION_COOKIE), 'GET', '/api/me');
      expect(me.body.user).toMatchObject({ id: ids.marcus, kind: 'user' });
    } finally {
      clock = now;
    }
    // The kept cookie lives as long as the instructor session it holds.
    expect(expired.cookies.get(PREVIEW_RETURN_COOKIE)?.maxAge).toBe(14 * 24 * 60 * 60);

    const none = await request('', 'POST', '/api/preview/exit');
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: 'not_previewing' });
    expect(none.cookies.size).toBe(0);
  });

  test('A26 preview is refused for an archived topic and an archived class', async () => {
    const archive = async (archivedAt: Date | null) => {
      await testDb.db.update(topics).set({ archivedAt }).where(eq(topics.id, ids.estimation));
      await testDb.db.update(classes).set({ archivedAt }).where(eq(classes.id, ids.classB));
    };
    await testDb.db.update(topics).set({ archivedAt: now }).where(eq(topics.id, ids.estimation));
    try {
      const topic = await call('marcus', 'POST', `${course}/preview`, {
        classId: ids.classB,
        topicId: ids.estimation,
      });
      expect(topic.status).toBe(404);
      expect(topic.cookies.has(SESSION_COOKIE)).toBe(false);
      await archive(now);
      const archived = await call('marcus', 'POST', `${course}/preview`, { classId: ids.classB });
      expect(archived.status).toBe(404);
      expect(archived.body).toEqual(topic.body);
      expect(archived.cookies.has(SESSION_COOKIE)).toBe(false);
    } finally {
      await archive(null);
    }
  });

  test('A26 a head revision of another type is left out of the preview', async () => {
    const { db } = testDb;
    const [resource] = await db
      .insert(resources)
      .values({
        courseId: ids.statistics,
        topicId: ids.sampling,
        type: 'reading_native',
        title: 'Mismatched head',
        position: 5,
        createdBy: ids.marcus,
      })
      .returning();
    if (!resource) throw new Error('no resource');
    const [revision] = await db
      .insert(resourceRevisions)
      .values({
        resourceId: resource.id,
        courseId: ids.statistics,
        type: 'exercise',
        content: {},
        contentHash: 'mismatch',
        createdBy: ids.marcus,
      })
      .returning();
    if (!revision) throw new Error('no revision');
    await db
      .update(resources)
      .set({ headRevisionId: revision.id })
      .where(eq(resources.id, resource.id));
    try {
      const started = await startAsMarcus();
      const release = await request(started.browser, 'GET', `/api/classes/${ids.classB}/release`);
      expect(release.status).toBe(200);
      const titles = release.body.topics.flatMap((t: { resources: { title: string }[] }) =>
        t.resources.map((r) => r.title),
      );
      expect(titles).toEqual(['Why samples vary', 'Sampling quiz']);
      const attempt = await request(
        started.browser,
        'POST',
        `/api/classes/${ids.classB}/resources/${resource.id}/exercise-attempt`,
      );
      expect(attempt.status).toBe(404);
    } finally {
      await db.update(resources).set({ archivedAt: now }).where(eq(resources.id, resource.id));
    }
  });

  test('A26 a class thread reaches the preview notifications', async () => {
    const thread = await call(
      'bea',
      'POST',
      `/api/classes/${ids.classB}/resources/${ids.samplingReading}/threads`,
      { audience: 'class', anchor: { kind: 'none' }, body: 'Why does the spread shrink?' },
    );
    expect(thread.status).toBe(200);
    const started = await startAsMarcus();
    const listed = await request(
      started.browser,
      'GET',
      `/api/classes/${ids.classB}/notifications`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ threadId: thread.body.id, excerpt: 'Why does the spread shrink?' }),
    ]);
    // A real member still gets the release rule: Marcus sees the same thread.
    const marcus = await call('marcus', 'GET', `/api/classes/${ids.classB}/notifications`);
    expect(marcus.body.items.map((n: { threadId: string }) => n.threadId)).toContain(
      thread.body.id,
    );
  });

  test('A26 a preview media URL follows the draft: visible yes, hidden and locked topics no', async () => {
    const { db } = testDb;
    const objectIn = async (topicId: string, title: string, visibility: 'visible' | 'hidden') => {
      const sha256 = createHash('sha256').update(title).digest('hex');
      const key = `courses/${ids.statistics}/objects/${sha256}`;
      await db.insert(storageObjects).values({
        courseId: ids.statistics,
        key,
        sha256,
        size: 10,
        contentType: 'application/pdf',
        createdBy: ids.marcus,
      });
      const [resource] = await db
        .insert(resources)
        .values({
          courseId: ids.statistics,
          topicId,
          type: 'reading_pdf',
          title,
          position: 6,
          visibility,
          createdBy: ids.marcus,
        })
        .returning();
      if (!resource) throw new Error('no resource');
      const [revision] = await db
        .insert(resourceRevisions)
        .values({
          resourceId: resource.id,
          courseId: ids.statistics,
          type: 'reading_pdf',
          content: { title },
          accessibleAlternative: { text: title },
          objectKeys: [key],
          contentHash: sha256,
          createdBy: ids.marcus,
        })
        .returning();
      if (!revision) throw new Error('no revision');
      await db
        .update(resources)
        .set({ headRevisionId: revision.id })
        .where(eq(resources.id, resource.id));
      return {
        resourceId: resource.id,
        url: `/api/classes/${ids.classB}/resources/${revision.id}/objects/${encodeURIComponent(key)}`,
      };
    };
    const visible = await objectIn(ids.sampling, 'Sampling handout', 'visible');
    const hidden = await objectIn(ids.sampling, 'Sampling key', 'hidden');
    // Estimation needs Sampling first, so it is locked for a student.
    const locked = await objectIn(ids.estimation, 'Estimation handout', 'visible');
    try {
      const started = await startAsMarcus();
      expect((await request(started.browser, 'GET', visible.url)).status).toBe(200);
      expect((await request(started.browser, 'GET', hidden.url)).status).toBe(404);
      expect((await request(started.browser, 'GET', locked.url)).status).toBe(404);
    } finally {
      for (const r of [visible, hidden, locked]) {
        await db.update(resources).set({ archivedAt: now }).where(eq(resources.id, r.resourceId));
      }
    }
  });

  test('A26 a preview exercise attempt stays out of the instructor review route', async () => {
    const course = asCourseScope(ids.statistics, ids.elena);
    const created = await createResource(
      testDb.db,
      course,
      ids.sampling,
      {
        type: 'exercise',
        title: 'Spread check',
        content: {
          schema: 'exercise.v1',
          steps: [
            {
              id: 'explain',
              kind: 'text',
              title: 'Explain',
              prompt: 'Why do averages vary less?',
              solution: 'Averaging cancels noise.',
              feedback: { saved: 'Saved.' },
            },
          ],
        },
      },
      now,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const exerciseId = created.value.id;
    const v2 = await publishRelease(testDb.db, course, { runtimes: DEV_RUNNER_RUNTIMES });
    if (!v2.ok) throw new Error(JSON.stringify(v2.report));
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(ids.classB, ids.statistics, ids.marcus, { releaseId: ids.releaseV1 }),
      { releaseId: v2.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);
    const attempts = `/api/classes/${ids.classB}/resources/${exerciseId}`;

    const started = await startAsMarcus();
    const previewed = await request(started.browser, 'POST', `${attempts}/exercise-attempt`);
    expect(previewed.status).toBe(200);
    const bea = await call('bea', 'POST', `${attempts}/exercise-attempt`);
    expect(bea.status).toBe(200);

    const review = await call('marcus', 'GET', `${attempts}/exercise-attempts`);
    expect(review.status).toBe(200);
    const reviewed = review.body.attempts.map((a: { id: string }) => a.id);
    expect(reviewed).toContain(bea.body.id);
    expect(reviewed).not.toContain(previewed.body.id);
  });
});
