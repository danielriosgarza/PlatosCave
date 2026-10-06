import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEV_RUNNER_RUNTIMES } from '../../src/config';
import { adoptRelease } from '../../src/db/content/adoption';
import { publishRelease } from '../../src/db/content/releases';
import type { Storage } from '../../src/storage/storage';
import { asClassScope, asCourseScope, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { readySession } from './kernel-channel';
import { call } from './notebook-sessions';
import { type Relay, startRelay } from './relay';
import { courseNotebook, tempStorage } from './working-copies';

/**
 * A notebook authored through the workspace-files form (P3-09c): the data file is uploaded with
 * the notebook, named by `metadata.parallax.files`, listed among the revision's objects, and the
 * copy-in of P3-09 then sends exactly the declared files.
 */

const start = new Date('2026-10-01T09:00:00Z');
const COURSE_URL = `/api/courses/${ids.statistics}`;
const SAMPLE = Buffer.from('a,b\n1,2\n', 'utf8');
let testDb: TestDatabase;
let relay: Relay;
let storage: { storage: Storage; cleanup: () => Promise<void> };

beforeAll(async () => {
  testDb = await createTestDatabase();
  storage = await tempStorage();
  relay = await startRelay(testDb, start, { storage: storage.storage });
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
  await storage?.cleanup();
});

function upload(route: string, cookie: string, filename: string, bytes: Uint8Array) {
  const boundary = '----parallax-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return relay.app.inject({
    method: 'POST',
    url: `${COURSE_URL}/${route}`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

describe('workspace files authored with a notebook', () => {
  test('A34 a notebook authored with workspace files declares them and copy-in sends exactly them', async () => {
    const elena = relay.world.cookie.elena;
    const sam = relay.world.cookie.sam;

    // Only an editor of the course stores workspace files; an empty file is refused.
    expect((await upload('workspace-files', sam, 'sample.csv', SAMPLE)).statusCode).toBe(404);
    const empty = await upload('workspace-files', elena, 'empty.csv', new Uint8Array());
    expect(empty.statusCode).toBe(400);

    const data = await upload('workspace-files', elena, 'sample.csv', SAMPLE);
    expect(data.statusCode, data.body).toBe(200);
    const stored = data.json() as { id: string; key: string; size: number };
    expect(stored.size).toBe(SAMPLE.length);

    // The notebook as the form writes it: the declaration is in the notebook's own metadata.
    const notebook = courseNotebook([{ path: 'data/sample.csv', resourceId: stored.id }]);
    const source = await upload(
      'uploads',
      elena,
      'Repeated samples.ipynb',
      Buffer.from(JSON.stringify(notebook)),
    );
    expect(source.statusCode, source.body).toBe(200);
    const sourceKey = (source.json() as { key: string }).key;

    const created = await call(
      relay,
      elena,
      'POST',
      `${COURSE_URL}/topics/${ids.sampling}/resources`,
      {
        type: 'notebook',
        title: 'Repeated samples',
        content: {
          sourceKey,
          workspaceFiles: [{ path: 'data/sample.csv', resourceId: stored.id, size: stored.size }],
        },
        objectKeys: [sourceKey, stored.key],
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const revisionId = created.body.headRevisionId as string;

    const course = asCourseScope(ids.statistics, ids.elena);
    const published = await publishRelease(testDb.db, course, { runtimes: DEV_RUNNER_RUNTIMES });
    if (!published.ok) throw new Error(JSON.stringify(published.report));
    const adopted = await adoptRelease(
      testDb.db,
      asClassScope(ids.classA, ids.statistics, ids.priya, { releaseId: ids.releaseV1 }),
      { releaseId: published.release.id, expectedReleaseId: ids.releaseV1 },
    );
    if (!adopted.ok) throw new Error(adopted.reason);

    const s = await readySession(relay, testDb, revisionId, { kernel: false });
    const files = await call(relay, sam, 'GET', `${s.url}/files`);
    expect(files.body.declared).toEqual([
      { path: 'data/sample.csv', size: SAMPLE.length, sha256: expect.any(String) },
    ]);
    const copied = await call(relay, sam, 'POST', `${s.url}/transfers`, { kind: 'copy_in' });
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(copied.body.transfers).toEqual([
      expect.objectContaining({ path: 'data/sample.csv', state: 'done', outcome: 'copied' }),
    ]);
    expect([...s.jupyter.files.keys()]).toEqual(['data/sample.csv']);
    expect(s.jupyter.files.get('data/sample.csv')?.toString()).toBe(SAMPLE.toString());
  });
});
