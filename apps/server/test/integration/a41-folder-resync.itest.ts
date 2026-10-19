import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { folderCourseId, folderRowId } from '../../src/content/folder-ids';
import { createSession } from '../../src/db/auth/sessions';
import { createTopic, updateResource } from '../../src/db/content/drafts';
import { ensureFolderCourse } from '../../src/db/content/sync';
import { createClass, createUser } from '../../src/db/identity';
import { classMemberships, courseMemberships, courses } from '../../src/db/schema';
import annotationsMap from '../../src/jobs/annotations-map.job';
import { workScopedJob } from '../../src/jobs/scoped';
import { FsStorage } from '../../src/storage/fs';
import { asCourseScope, cookieFor } from '../fixtures/world';
import { ANA, entry, type Folder, folder, ids, type SyncWorld, syncWorld } from './course-folder';

// A41 (§13, N4): a changed course folder syncs to the same resources, with new revisions only
// where content changed, and notes on the earlier revision are mapped or need reattachment.

let w: SyncWorld;
let courseId: string;
beforeAll(async () => {
  w = await syncWorld();
  await workScopedJob(w.boss, w.db, annotationsMap, w.app.log, w.worker, {
    storage: w.storage,
    boss: w.boss,
  });
  courseId = folderCourseId(w.ana, 'reef-ecology');
});
afterAll(() => w?.close());

type Row = Record<string, unknown>;
const rowId = (folderId: string) => folderRowId(courseId, 'resource', folderId);
const find = (rows: Row[], folderId: string) => rows.find((r) => r.id === rowId(folderId)) ?? {};
const versions = async () => (await w.rows(courseId)).releases.map((r) => r.version);
const call = async (
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) => {
  const res = await w.app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });
  return { status: res.statusCode, body: res.json() };
};
/** The folder as it was synced last, its web deck given one more slide. */
const latest = () => {
  const f = folder('course-changed');
  const deck = entry(f, ids.transects);
  if (deck.type === 'slides_web') deck.source.markdown += '\n---\n\n# Density\n';
  return f;
};

test('A41 a changed folder gives new revisions of the same resources and a new release, and a note stays attached or shows Needs reattachment', {
  timeout: 180_000,
}, async () => {
  expect((await w.sync(folder('course'))).report).toContain('release 1 published');
  const [release1] = (await w.rows(courseId)).releases;
  const cls = await createClass(w.db, asCourseScope(courseId, w.ana), {
    name: 'Reef ecology 2026',
  });
  const sam = await createUser(w.db, { email: 'sam.reyes@example.org', name: 'Sam Reyes' });
  await w.db.insert(classMemberships).values([
    { classId: cls.id, userId: w.ana, role: 'instructor' },
    { classId: cls.id, userId: sam, role: 'student' },
  ]);
  const samCookie = cookieFor((await createSession(w.db, sam)).token);
  const adopt = `/api/classes/${cls.id}/adopt`;
  const first = { releaseId: release1?.id, expectedReleaseId: null };
  expect((await call(w.cookie, 'POST', adopt, first)).status).toBe(200);

  // Sam reviews the prerequisite topic's reading, and notes two paragraphs of the next topic's
  // reading: one is reworded in the changed copy, one removed.
  const tides = `topics/${folderRowId(courseId, 'topic', ids.tides)}`;
  const review = `/api/classes/${cls.id}/${tides}/reviews/${rowId(ids.tidesReading)}`;
  expect((await call(samCookie, 'PUT', review, { reviewed: true })).status).toBe(200);
  const before = await w.rows(courseId);
  const head = before.revisions.find(
    (r) => r.id === find(before.resources, ids.methods).head_revision_id,
  );
  const { blockMap: blocks } = (head?.derived ?? {}) as {
    blockMap: { id: string; text: string }[];
  };
  const notes: string[] = [];
  const annotations = `/api/classes/${cls.id}/resources/${rowId(ids.methods)}/annotations`;
  for (const quote of ['A transect is a line', 'A quadrat is a square frame']) {
    const block = blocks.find((b) => b.text.startsWith(quote));
    const anchor = {
      kind: 'text',
      blockId: block?.id,
      start: 0,
      end: quote.length,
      quote,
      prefix: '',
      suffix: block?.text.slice(quote.length, quote.length + 32),
    };
    const note = await call(samCookie, 'POST', annotations, { kind: 'note', anchor, body: 'Why?' });
    expect(note.status).toBe(200);
    notes.push(note.body.id);
  }

  // The changed copy: topics reordered, the reading reworded and renamed, the deck renamed and
  // moved with its entry to the other topic without a change of bytes.
  const changed = await w.sync(folder('course-changed'));
  expect(changed.report.slice(0, 2)).toEqual([
    'created 0, new revisions 1, moved 6, fields changed 0, archived 0, unchanged 4, editor only 0',
    'release 2 published',
  ]);
  const after = await w.rows(courseId);
  expect(after.resources.map((r) => r.id)).toEqual(before.resources.map((r) => r.id));
  expect(find(after.resources, ids.deck)).toMatchObject({
    topic_id: folderRowId(courseId, 'topic', ids.tides),
    position: 1,
    head_revision_id: find(before.resources, ids.deck).head_revision_id,
  });
  const reworded = find(after.resources, ids.methods).head_revision_id;
  expect(reworded).not.toBe(find(before.resources, ids.methods).head_revision_id);
  expect(after.revisions.map((r) => r.id)).toEqual(
    expect.arrayContaining([...before.revisions.map((r) => r.id), reworded]),
  );
  expect(after.revisions).toHaveLength(before.revisions.length + 1);
  expect(await versions()).toEqual([1, 2]);

  // Adopting release 2 queues the mapping of Sam's notes, which the worker places.
  const second = { releaseId: after.releases[1]?.id, expectedReleaseId: release1?.id };
  expect((await call(w.cookie, 'POST', adopt, second)).status).toBe(200);
  // The prerequisite topic now holds the deck too, which Sam reviews to open the reading again.
  const deck = `/api/classes/${cls.id}/${tides}/reviews/${rowId(ids.deck)}`;
  expect((await call(samCookie, 'PUT', deck, { reviewed: true })).status).toBe(200);
  let placed: string[] = [];
  for (let i = 0; i < 120 && !(placed.length === 2 && !placed.includes('pending')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const listed = (await call(samCookie, 'GET', annotations)).body.annotations as Row[];
    placed = notes.map((id) => String((listed.find((a) => a.id === id)?.placement as Row)?.status));
  }
  expect(placed).toEqual(['mapped', 'needs_reattachment']);
});

test('A41 a second sync of an unchanged folder creates no revision and no release', {
  timeout: 180_000,
}, async () => {
  const before = await w.rows(courseId);
  const again = await w.sync(folder('course-changed'));
  expect(again.report).toEqual([
    'created 0, new revisions 0, moved 0, fields changed 0, archived 0, unchanged 11, editor only 0',
    'nothing to publish: the drafts equal the newest release',
  ]);
  // The same deck saved with CRLF is the same text.
  const crlf = folder('course-changed');
  const deck = entry(crlf, ids.transects);
  if (deck.type === 'slides_web')
    deck.source.markdown = deck.source.markdown.replaceAll('\n', '\r\n');
  expect((await w.sync(crlf)).code).toBe(0);
  expect(await w.rows(courseId)).toEqual(before);

  // Two syncs of one changed folder started together leave exactly one new release.
  // The second has a storage root of its own: on Windows two renames onto one path fail.
  const storage = new FsStorage(await mkdtemp(join(tmpdir(), 'parallax-sync-')));
  const both = await Promise.all([w.sync(latest()), w.sync(latest(), {}, { storage })]);
  expect(both.map((r) => r.report.some((line) => line.endsWith('published'))).sort()).toEqual([
    false,
    true,
  ]);
  expect(await versions()).toEqual([1, 2, 3]);

  // The same fixture for a second owner, and under a second folder name: courses of their own.
  const tomas = 'tomas.silva@example.org';
  const owner = await createUser(w.db, { email: tomas, name: 'Tomás Silva' });
  const instructor = { email: tomas, path: 'instructors/tomas/instructor.yaml' };
  await w.sync(folder('course'), { instructor }, { instructorEmails: [ANA, tomas] });
  await w.sync(folder('course'), { course: 'reef-copy' });
  const mine = new Set((await w.rows(courseId)).resources.map((r) => r.id));
  for (const other of [folderCourseId(owner, 'reef-ecology'), folderCourseId(w.ana, 'reef-copy')]) {
    const { resources, releases } = await w.rows(other);
    expect(resources).toHaveLength(mine.size);
    expect(resources.filter((r) => mine.has(String(r.id)))).toEqual([]);
    expect(releases.map((r) => r.version)).toEqual([1]);
  }
});

test('A41 a head revision that came from the editor is not overwritten unless sync is told to', {
  timeout: 180_000,
}, async () => {
  const scope = asCourseScope(courseId, w.ana);
  const path = 'surveys/reading/survey-methods.md';
  const { revision } = find((await w.rows(courseId)).resources, ids.methods) as {
    revision: number;
  };
  const edit = {
    expectedRevision: revision,
    content: { markdown: '# Methods\n\nFrom the editor.' },
  };
  const saved = await updateResource(w.db, scope, rowId(ids.methods), edit, new Date());
  if (!saved.ok) throw new Error(saved.reason);
  const before = await w.rows(courseId);
  const kept = await w.sync(latest());
  const editor =
    'its head revision was saved in the editor; sync with --overwrite-editor to replace it';
  expect(kept).toEqual({ code: 1, report: [`${path}: ${editor}`] });
  expect(await w.rows(courseId)).toEqual(before);
  const overwriteEditor = { overwriteEditor: true, acceptNewIds: false };
  expect((await w.sync(latest(), { options: overwriteEditor })).code).toBe(0);
  const overwritten = await w.rows(courseId);
  const headId = find(overwritten.resources, ids.methods).head_revision_id;
  const head = overwritten.revisions.find((r) => r.id === headId);
  expect(head?.provenance).toMatchObject({ source: 'folder', path });
  expect(overwritten.revisions.map((r) => r.id)).toContain(saved.value.head?.id);

  // A removed entry and a removed topic are archived; a topic made in the editor stays.
  const field = await createTopic(w.db, scope, { title: 'Field notes' }, new Date());
  const smaller = latest();
  smaller.manifest.topics = smaller.manifest.topics.filter((t) => t.id !== ids.tides);
  const [surveys] = smaller.manifest.topics;
  if (!surveys) throw new Error('no topic');
  surveys.prerequisites = [];
  surveys.resources = surveys.resources.filter((r) => r.id !== ids.shiny);
  smaller.manifest.files = smaller.manifest.files.filter((file) => !file.path.startsWith('tides/'));
  const archiving = await w.sync(smaller);
  expect([archiving.code, archiving.report[0]]).toEqual([
    0,
    'created 0, new revisions 0, moved 2, fields changed 1, archived 4, unchanged 4, editor only 1',
  ]);
  const archived = await w.rows(courseId);
  for (const table of ['topics', 'resources', 'revisions'] as const) {
    expect(archived[table].length).toBeGreaterThanOrEqual(overwritten[table].length);
  }
  const tides = archived.topics.find((t) => t.id === folderRowId(courseId, 'topic', ids.tides));
  expect(tides?.archived_at).not.toBeNull();
  for (const id of [ids.shiny, ids.deck])
    expect(find(archived.resources, id).archived_at).not.toBeNull();
  expect(archived.topics.find((t) => t.id === field.id)?.archived_at).toBeNull();

  // An id written again at the path the earlier one recorded stops sync, unless it is accepted.
  const rewritten = '3e1d2c4b-5a69-4f78-9e0d-1c2b3a4f5e6d';
  surveys.resources = surveys.resources.map((r) =>
    r.id === ids.methods ? { ...r, id: rewritten } : r,
  );
  const stands = `${path}: ${rewritten} stands where ${ids.methods} was recorded: put ${ids.methods} back, or sync with --accept-new-ids`;
  expect(await w.sync(smaller)).toEqual({ code: 1, report: [stands] });
  expect(await w.rows(courseId)).toEqual(archived);
  const accepted = await w.sync(smaller, {
    options: { overwriteEditor: false, acceptNewIds: true },
  });
  expect(accepted.report.slice(0, 2)).toEqual([
    'created 1, new revisions 0, moved 0, fields changed 0, archived 1, unchanged 6, editor only 1',
    `${path}: ${rewritten} replaces ${ids.methods}, which is archived`,
  ]);
  const replaced = await w.rows(courseId);
  expect(find(replaced.resources, rewritten).archived_at).toBeNull();
  expect(find(replaced.resources, ids.methods).archived_at).not.toBeNull();

  // A run stopped after its drafts were written publishes once on the next run.
  const deck = entry(smaller, ids.transects);
  if (deck.type === 'slides_web') deck.source.markdown += '\n---\n\n# Cover\n';
  const published = (await versions()).length;
  const stopped = await w.sync(smaller, {}, { wait: { idleMs: 0, pollMs: 200 } });
  expect(stopped.code).toBe(3);
  expect(await versions()).toHaveLength(published);
  expect((await w.sync(smaller)).report).toContain(`release ${published + 1} published`);
  expect((await w.sync(smaller)).report).toContain(
    'nothing to publish: the drafts equal the newest release',
  );
  expect(w.errors).toEqual([]);
});

/** Every row of the tables a run would write first: its course, objects, drafts and events. */
const everything = () =>
  Promise.all(
    ['courses', 'storage_objects', 'topics', 'resources', 'audit_events'].map(
      async (t) => (await w.db.execute(sql`select * from ${sql.identifier(t)} order by id`)).rows,
    ),
  );

test('a bundle that the checks of its manifest refuse exits 2, asks for no file, and writes no course and no object', async () => {
  const before = await everything();
  const data = 'sampling/notebooks/counts/data/quadrats.csv';
  const deck = 'sampling/slides/deck.pdf';
  const methods = 'sampling/reading/methods.md';
  const cases: [string, (f: Folder) => void][] = [
    ['the bundle holds other files than its entries name', (f) => f.manifest.files.pop()],
    [
      `${methods}: no html file of its entry`,
      (f) => {
        f.manifest.files = f.manifest.files.map((file) =>
          file.path === methods ? { ...file, format: 'html' } : file,
        );
      },
    ],
    [`${data}: stands after its notebook`, (f) => f.manifest.files.reverse()],
    // The reading names the deck's file, which a reading stores as Markdown and a deck as a PDF.
    [
      `${deck}: named in two roles`,
      (f) => {
        const reading = entry(f, ids.methods);
        if (reading.type === 'reading_native') reading.source.file = deck;
        f.manifest.files = f.manifest.files.filter((file) => file.path !== methods);
      },
    ],
  ];
  for (const [line, change] of cases) {
    const f = folder('course');
    change(f);
    w.asked.length = 0;
    expect(await w.sync(f, { course: 'reef-bundle' })).toEqual({ code: 2, report: [line] });
    expect(w.asked).toEqual([]);
  }
  expect(await everything()).toEqual(before);
});

test('an address without an account or outside INSTRUCTOR_EMAILS, an archived course and a course without its owner grant each stop sync before any draft is written', async () => {
  const made = async (name: string) => {
    const course = await ensureFolderCourse(w.db, { id: w.ana, email: ANA }, name, 'Reef', [ANA]);
    if (!course.ok) throw new Error(course.reason);
    return course.scope.courseId;
  };
  const archived = await made('reef-archived');
  await w.db.update(courses).set({ archivedAt: new Date() }).where(eq(courses.id, archived));
  const ungranted = await made('reef-ungranted');
  const grant = eq(courseMemberships.courseId, ungranted);
  await w.db.update(courseMemberships).set({ owner: false }).where(grant);
  const before = await everything();
  const nobody = { email: 'nobody@example.org', path: 'instructors/nobody/instructor.yaml' };
  w.asked.length = 0;
  const runs = [
    await w.sync(folder('course'), { instructor: nobody, course: 'reef-nobody' }),
    await w.sync(folder('course'), { course: 'reef-unlisted' }, { instructorEmails: [] }),
    await w.sync(folder('course'), { course: 'reef-archived' }),
    await w.sync(folder('course'), { course: 'reef-ungranted' }),
  ];
  expect(runs).toEqual(
    [
      `${nobody.path}: no active account has this address; that person signs in once first`,
      'instructor.yaml: reef-unlisted: the address is not in INSTRUCTOR_EMAILS, so no course is created for it',
      'instructor.yaml: reef-archived: the course is archived',
      'instructor.yaml: reef-ungranted: the account of the address does not own this course',
    ].map((line) => ({ code: 1, report: [line] })),
  );
  expect(w.asked).toEqual([]);
  expect(await everything()).toEqual(before);
});

test('a stop after the course was created, or after drafts were written, says so', async () => {
  const refused = folder('course');
  const deck = 'sampling/slides/deck.pdf';
  refused.bytes.set(deck, new TextEncoder().encode('Reef zones, not a PDF'));
  expect(await w.sync(refused, { course: 'reef-refused' })).toMatchObject({
    code: 1,
    report: ['created course reef-refused', expect.stringMatching(`^${deck}: `)],
  });
  // A bundle the reader did not make: the draft service refuses what the plan let through.
  const insecure = folder('course');
  const shiny = entry(insecure, ids.shiny);
  if (shiny.type === 'shiny') shiny.source.url = 'http://shiny.example.org/tide/';
  expect(await w.sync(insecure, { course: 'reef-insecure' })).toEqual({
    code: 1,
    report: [
      'created course reef-insecure',
      'sampling/notebooks/tide.shiny.yaml: The address must start with https:// (http:// only for localhost)',
      '8 of 11 draft changes were written; the next sync goes on from them',
    ],
  });
});
