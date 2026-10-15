import { text } from 'node:stream/consumers';
import { declareWorkspaceFiles } from '@parallax/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { folderCourseId, folderRowId } from '../../src/content/folder-ids';
import { listResourceJobStatus } from '../../src/db/jobs/derived';
import { isProcessed } from '../../src/jobs/reading-ingest.job';
import { asCourseScope } from '../fixtures/world';
import { entry, type Folder, folder, ids, type SyncWorld, syncWorld } from './course-folder';

// A40 at level 1 (§13, N4): `syncCourse` stores what the editor's forms store for the same files.

let w: SyncWorld;
beforeAll(async () => {
  w = await syncWorld();
});
afterAll(() => w?.close());

/** One file posted as the editor's upload and workspace-file forms post it. */
async function send(courseId: string, route: string, path: string, bytes: Uint8Array) {
  const boundary = '----parallax-a40';
  const name = path.split('/').pop();
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return w.app.inject({
    method: 'POST',
    url: `/api/courses/${courseId}/${route}`,
    headers: { cookie: w.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(part), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  });
}

/** The body of `POST …/resources` that the editor's form for the entry's type sends. */
async function editorBody(f: Folder, courseId: string, r: ReturnType<typeof entry>) {
  const upload = async (route: string, file: string, bytes = f.bytes.get(file)) =>
    (await send(courseId, route, file, bytes ?? new Uint8Array())).json();
  const { type, title } = r;
  const alternative = r.alternative ? { accessibleAlternative: { text: r.alternative } } : {};
  if (r.type === 'slides_web') return { type, title, content: { markdown: r.source.markdown } };
  if (r.type === 'shiny') return { type, title, content: { url: r.source.url } };
  if (r.type === 'exercise' || r.type === 'test')
    return { type, title, content: r.source.definition };
  if (r.type !== 'notebook') {
    const { key, format } = await upload('uploads', r.source.file);
    const content = r.type === 'reading_native' ? { sourceKey: key, format } : { objectKey: key };
    return { type, title, content, objectKeys: [key], ...alternative };
  }
  const data: { path: string; resourceId: string; size: number; key: string }[] = [];
  for (const { path, file } of r.source.data) {
    const { id, size, key } = await upload('workspace-files', file);
    data.push({ path, resourceId: id, size, key });
  }
  const declared = data.map(({ path, resourceId }) => ({ path, resourceId }));
  const notebook = declareWorkspaceFiles(
    new TextDecoder().decode(f.bytes.get(r.source.file)),
    declared,
  );
  const { key } = await upload('uploads', r.source.file, new TextEncoder().encode(notebook));
  const workspaceFiles = data.map(({ path, resourceId, size }) => ({ path, resourceId, size }));
  return {
    type,
    title,
    content: { sourceKey: key, workspaceFiles },
    objectKeys: [key, ...data.map((d) => d.key)],
  };
}

/** The revision fields of resources' heads, and `derived` without the job's id and time. */
async function heads(courseId: string, resourceIds: string[]) {
  const { resources, revisions } = await w.rows(courseId);
  return resourceIds.map((id) => {
    const at = resources.find((r) => r.id === id)?.head_revision_id;
    const { type, content, object_keys, accessible_alternative, derived } =
      revisions.find((r) => r.id === at) ?? {};
    const status = { ...(derived as { status?: object }).status, jobId: null, updatedAt: null };
    return {
      type,
      content,
      object_keys,
      accessible_alternative,
      derived: { ...(derived as object), status },
    };
  });
}

test('A40 a synced course folder holds the types, stored content and derived output the editor produces for the same files', {
  timeout: 180_000,
}, async () => {
  // The fixture, its notebook given a second data file.
  const f = folder('course');
  const second = 'sampling/notebooks/counts/data/transects.csv';
  f.bytes.set(second, new TextEncoder().encode('transect,fish\n1,12\n2,9\n'));
  const counts = entry(f, '9d8c7b6a-5f4e-4d3c-a2b1-0f9e8d7c6b5a');
  if (counts.type !== 'notebook') throw new Error('no notebook');
  counts.source.data.push({ path: 'data/transects.csv', file: second });
  const at = f.manifest.files.findIndex((file) => file.format === 'data') + 1;
  f.manifest.files.splice(at, 0, { path: second, sha256: '', size: 0, format: 'data' });

  expect(await w.sync(f)).toMatchObject({
    code: 0,
    report: expect.arrayContaining(['release 1 published']),
  });
  const scope = asCourseScope(folderCourseId(w.ana, 'reef-ecology'), w.ana);
  const { courseId } = scope;
  const objects = sql`select key, content_type from storage_objects where course_id = ${courseId}`;
  const types = async () => (await w.db.execute(sql`${objects} order by key`)).rows;
  const stored = await types();

  // The same files through the upload, workspace-file and resource routes, into a second topic.
  const post = async (url: string, payload: object) =>
    (await w.app.inject({ method: 'POST', url, headers: { cookie: w.cookie }, payload })).json();
  const topic = await post(`/api/courses/${courseId}/topics`, { title: 'Added in the editor' });
  const entries = f.manifest.topics.flatMap((t) => t.resources);
  const made: string[] = [];
  for (const r of entries) {
    const body = await editorBody(f, courseId, r);
    made.push((await post(`/api/courses/${courseId}/topics/${topic.id}/resources`, body)).id);
  }
  for (let i = 0; i < 240; i++) {
    const heads = (await listResourceJobStatus(w.db, scope)).filter((h) => isProcessed(h.type));
    if (heads.every((h) => h.status?.state === 'ready' || h.status?.state === 'failed')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const mine = await heads(
    courseId,
    entries.map((r) => folderRowId(courseId, 'resource', r.id)),
  );
  expect(new Set(mine.map((head) => head.type)).size).toBe(8);
  expect(await heads(courseId, made)).toEqual(mine);
  // The editor's uploads found every object stored as sync stored it, with its type.
  expect(await types()).toEqual(stored);
  type Declared = { sourceKey: string; workspaceFiles: { path: string; resourceId: string }[] };
  const notebook = mine.find((h) => h.type === 'notebook')?.content;
  const { sourceKey, workspaceFiles } = (notebook ?? {}) as Declared;
  expect(workspaceFiles.map((file) => file.path)).toEqual([
    'data/quadrats.csv',
    'data/transects.csv',
  ]);
  const { body } = await w.storage.get(sourceKey);
  expect(JSON.parse(await text(body)).metadata.parallax.files).toEqual(
    workspaceFiles.map(({ path, resourceId }) => ({ path, resourceId })),
  );

  // References by folder id are stored as row ids, as the topic form stores them.
  const sampling = (await w.rows(courseId)).topics.find(
    (t) => t.id === folderRowId(courseId, 'topic', ids.sampling),
  );
  expect(sampling).toMatchObject({
    prerequisites: [folderRowId(courseId, 'topic', ids.tides)],
    completion_rule: {
      requires: ['reviewed:*', `submitted:${folderRowId(courseId, 'resource', ids.quiz)}`],
    },
  });

  // A file the upload route refuses: sync refuses it with the route's message, and writes no draft.
  const refused = [
    ['sampling/slides/deck.pdf', 'Reef zones, not a PDF'],
    ['sampling/reading/methods.md', '# Survey methods\n\0'],
  ] as const;
  for (const [path, content] of refused) {
    const bytes = new TextEncoder().encode(content);
    const route = await send(courseId, 'uploads', path, bytes);
    expect(route.statusCode).toBe(400);
    const changed = folder('course');
    changed.bytes.set(path, bytes);
    const before = await w.rows(courseId);
    expect(await w.sync(changed)).toEqual({
      code: 1,
      report: [`${path}: ${route.json().message}`],
    });
    expect(await w.rows(courseId)).toEqual(before);
  }
  expect(w.errors).toEqual([]);
});
