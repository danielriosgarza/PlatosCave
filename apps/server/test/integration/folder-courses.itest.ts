import { eq, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { folderCourseId, folderRowId, isFolderRow } from '../../src/content/folder-ids';
import { createSession } from '../../src/db/auth/sessions';
import { createResource, createTopic, updateTopic } from '../../src/db/content/drafts';
import {
  ensureFolderCourse,
  type FolderOwner,
  findFolderOwner,
  findSyncedCourse,
  loadSyncState,
} from '../../src/db/content/sync';
import { createUser } from '../../src/db/identity';
import { auditEvents, courseMemberships, courses, topics, users } from '../../src/db/schema';
import { buildWorld, cookieFor, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';

// The queries of `parallax sync` for its owner, its course and the drafts it plans against
// (docs/design/course-folder.md §4, §10), on real PostgreSQL. The fixtures follow the design's
// fictional course "Reef ecology" by Ana Lima.

const ANA = 'ana.lima@example.org';
const allowed = [ANA, 'elena@example.test'];
const deck = { markdown: '# Transects\n\n---\n\n# Quadrats' };
const now = new Date();

let testDb: TestDatabase;
let app: FastifyInstance;
let ana: FolderOwner;
let cookie: string;
let auditBefore: string[];
let coursesBefore: number;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  await buildWorld(db);
  ana = { id: await createUser(db, { email: ANA, name: 'Ana Lima' }), email: ANA };
  cookie = cookieFor((await createSession(db, ana.id)).token);
  auditBefore = (await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
  coursesBefore = (await db.select().from(courses)).length;
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), { db });
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

let made = 0;
/** One of Ana's folder courses, with a topic and a resource created with their derived ids. */
async function folderCourse() {
  const { db } = testDb;
  const folder = `reef-${made++}`;
  const course = await ensureFolderCourse(db, ana, folder, 'Reef', allowed);
  if (!course.ok) throw new Error(course.reason);
  const { scope } = course;
  const topicId = folderRowId(scope.courseId, 'topic', 'sampling');
  await createTopic(db, scope, { id: topicId, title: 'Sampling' }, now);
  const resourceId = folderRowId(scope.courseId, 'resource', 'transects');
  const input = { id: resourceId, type: 'slides_web' as const, title: 'Transects', content: deck };
  const created = await createResource(db, scope, topicId, input, now);
  if (!created.ok) throw new Error(created.reason);
  return { scope, folder, topicId, resourceId };
}

describe('folder courses in the database', () => {
  test('no account for an address, a deactivated account and a preview principal give no owner, and no row of users is created', async () => {
    const { db } = testDb;
    const people = await db.select().from(users);
    expect(await findFolderOwner(db, 'Ana.Lima@example.org')).toEqual(ana);
    expect(await findFolderOwner(db, 'nobody@example.org')).toBeNull();
    await db.update(users).set({ deactivatedAt: now }).where(eq(users.id, ids.olivia));
    expect(await findFolderOwner(db, 'olivia@example.test')).toBeNull();
    // A preview principal holds no address (users_kind_shape): its owner's finds the owner.
    expect(people.find((u) => u.id === ids.previewB)).toMatchObject({ kind: 'preview' });
    const marcus = { id: ids.marcus, email: 'marcus@example.test' };
    expect(await findFolderOwner(db, marcus.email)).toEqual(marcus);
    expect(await db.select().from(users)).toHaveLength(people.length);
  });

  test('a course is created once, under the allow-list rule, and found again by findSyncedCourse', async () => {
    const { db } = testDb;
    const id = folderCourseId(ana.id, 'reef-ecology');
    const refused = await ensureFolderCourse(db, ana, 'reef-ecology', 'Reef ecology', []);
    expect(refused).toEqual({ ok: false, reason: 'not_instructor' });
    expect(await findSyncedCourse(db, ana.id, 'reef-ecology')).toBeNull();
    const first = await ensureFolderCourse(db, ana, 'reef-ecology', 'Reef ecology', allowed);
    expect(first).toMatchObject({ ok: true, created: true, scope: { courseId: id } });
    // Found again without the allow-list, with the title it was created with.
    const again = await ensureFolderCourse(db, ana, 'reef-ecology', 'Reef ecology II', []);
    expect(again).toMatchObject({
      ok: true,
      created: false,
      scope: { courseId: id, courseTitle: 'Reef ecology', user: { id: ana.id } },
    });
    expect(await findSyncedCourse(db, ana.id, 'reef-ecology')).toBe(id);
    expect(await db.select().from(courses).where(eq(courses.id, id))).toHaveLength(1);
  });

  test('another owner or folder name gives another course', async () => {
    const elena = { id: ids.elena, email: 'elena@example.test' };
    const pairs = [
      [ana, 'reef-ecology'],
      [ana, 'reef-ecology-2'],
      [elena, 'reef-ecology'],
    ] as const;
    const found = [];
    for (const [owner, name] of pairs) {
      const course = await ensureFolderCourse(testDb.db, owner, name, 'Reef ecology', allowed);
      found.push(course.ok && course.scope.courseId);
    }
    expect(found).toEqual(pairs.map(([owner, name]) => folderCourseId(owner.id, name)));
    expect(new Set(found).size).toBe(3);
  });

  test('an archived course, and one whose owner grant was removed, are refused and nothing is written', async () => {
    const { db } = testDb;
    const archived = await folderCourse();
    const ungranted = await folderCourse();
    await db
      .update(courses)
      .set({ archivedAt: now })
      .where(eq(courses.id, archived.scope.courseId));
    await db
      .update(courseMemberships)
      .set({ owner: false })
      .where(eq(courseMemberships.courseId, ungranted.scope.courseId));
    const rows = () =>
      Promise.all(
        [courses, courseMemberships, topics, auditEvents].map((t) => db.select().from(t)),
      );
    const before = await rows();
    expect(await ensureFolderCourse(db, ana, archived.folder, 'Reef', allowed)).toEqual({
      ok: false,
      reason: 'archived',
    });
    expect(await ensureFolderCourse(db, ana, ungranted.folder, 'Reef', allowed)).toEqual({
      ok: false,
      reason: 'not_owner',
    });
    expect(await rows()).toEqual(before);
  });

  test('a topic and a resource created with an id have it, and without one a random id as before', async () => {
    const { db } = testDb;
    const { scope, topicId, resourceId } = await folderCourse();
    const topic = await createTopic(db, scope, { title: 'Editor topic' }, now);
    const input = { type: 'slides_web' as const, title: 'Editor deck', content: deck };
    const resource = await createResource(db, scope, topic.id, input, now);
    if (!resource.ok) throw new Error(resource.reason);
    const state = await loadSyncState(db, scope, 'reef');
    expect(state.topics.map((t) => t.id)).toEqual([topicId, topic.id]);
    expect(state.resources.map((r) => r.id)).toEqual([resourceId, resource.value.id]);
    const random = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect([topic.id, resource.value.id]).toEqual([random, random]);
    // No route passes an id: a body's is dropped, and the row gets a random one.
    const wanted = folderRowId(scope.courseId, 'topic', 'from-a-route');
    const res = await app.inject({
      method: 'POST',
      url: `/api/courses/${scope.courseId}/topics`,
      headers: { cookie },
      payload: { id: wanted, title: 'Posted' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).not.toBe(wanted);
    expect(isFolderRow(res.json().id)).toBe(false);
  });

  test('loadSyncState reads every draft of the course, archived ones included, each resource with its head', async () => {
    const { db } = testDb;
    const { scope, topicId, resourceId } = await folderCourse();
    const archive = { expectedRevision: 1, archived: true };
    expect((await updateTopic(db, scope, topicId, archive, now)).ok).toBe(true);
    expect(await loadSyncState(db, scope, 'reef-ecology')).toEqual({
      courseId: scope.courseId,
      folder: 'reef-ecology',
      topics: [
        {
          id: topicId,
          position: 0,
          title: 'Sampling',
          objective: '',
          prerequisites: [],
          completionRule: null,
          estimatedMinutes: null,
          revision: 2,
          archived: true,
        },
      ],
      resources: [
        {
          id: resourceId,
          topicId,
          type: 'slides_web',
          title: 'Transects',
          position: 0,
          visibility: 'visible',
          revision: 1,
          archived: false,
          head: { content: deck, objectKeys: [], accessibleAlternative: null, provenance: null },
        },
      ],
    });
  });

  test('audit_events gains only the rows of createCourse', async () => {
    const { db } = testDb;
    const added = await db
      .select()
      .from(auditEvents)
      .where(notInArray(auditEvents.id, auditBefore));
    const created = (await db.select().from(courses)).length - coursesBefore;
    expect(created).toBeGreaterThan(0);
    expect(added.map((a) => a.action)).toEqual(Array<string>(created).fill('course.create'));
  });
});
