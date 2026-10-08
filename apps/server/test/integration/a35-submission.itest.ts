import { notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { removeMember } from '../../src/db/members';
import { notebookSessions, notebookSubmissions } from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { asManagerScope, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { readySession } from './kernel-channel';
import { call } from './notebook-sessions';
import { type Relay, startRelay } from './relay';
import {
  type ConnectedNotebook,
  connectedNotebook,
  DATA_CSV,
  HIDDEN_CHECKS,
  tempStorage,
  workingCopyUrl,
} from './working-copies';

/**
 * A35 (spec §10.5, docs/design/connector.md §11): an instructor receives a notebook submitted
 * from a personal computer. They inspect the snapshot without connecting to that computer;
 * trusted grading runs separately, and no hidden test material was sent to it.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let storage: { storage: Storage; cleanup: () => Promise<void> };
let notebook: ConnectedNotebook;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  storage = await tempStorage();
  relay = await startRelay(testDb, start, { storage: storage.storage });
  notebook = await connectedNotebook(testDb.db, storage.storage, start);
  cookie = relay.world.cookie.sam;
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
  await storage?.cleanup();
});

beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

/** What the content origin serves for a download link, as a browser asks: its host, no cookie. */
const fetchContent = (url: string) => {
  const parsed = new URL(url);
  return relay.app.inject({ method: 'GET', url: parsed.pathname, headers: { host: parsed.host } });
};

describe('A35 submitted snapshots', () => {
  test('A35 the instructor opens the snapshot without any connector call', async () => {
    const s = await readySession(relay, testDb, notebook.revisionId, {
      kernel: false,
      report: { environment: { os: 'linux', arch: 'amd64', runtime: 'Python 3.12.4' } },
    });
    const copy = (await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId))).body;
    s.jupyter.files.set('results.csv', Buffer.from('mean\n0.6\n'));
    const out = await call(relay, cookie, 'POST', `${s.url}/transfers`, {
      kind: 'copy_out',
      paths: ['results.csv'],
    });
    const fileId = out.body.transfers[0].id as string;
    const receipt = await call(
      relay,
      cookie,
      'POST',
      `/api/classes/${ids.classA}/notebook-working-copies/${copy.id}/submit`,
      {
        revision: copy.currentRevision,
        sessionId: s.sessionId,
        transferIds: [fileId],
        submissionKey: 'a35-key-00001',
      },
    );
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);

    // The student's computer goes away; from here on no connector is reachable.
    const seen = s.connector.received.length;
    s.connector.close();
    await relay.until(() => relay.links.get(s.connectorId) === undefined, 'the link to drop');

    const priya = relay.world.cookie.priya;
    const listing = await call(
      relay,
      priya,
      'GET',
      `/api/classes/${ids.classA}/resources/${notebook.resourceId}/notebook-submissions`,
    );
    expect(listing.status).toBe(200);
    const [submitted] = listing.body.submissions;
    expect(submitted).toMatchObject({
      id: receipt.body.id,
      student: { id: ids.sam },
      resourceRevisionId: notebook.revisionId,
      workingCopyRevision: copy.currentRevision,
      files: [{ id: fileId, path: 'results.csv', size: 9 }],
      environment: {
        runtime: 'connector',
        os: 'linux',
        arch: 'amd64',
        interpreter: 'Python 3.12.4',
        kernel: 'Python 3',
        language: 'python',
      },
    });

    // The snapshot and its file come from Parallax's storage through the content origin.
    const notebookLink = await call(
      relay,
      priya,
      'GET',
      `/api/classes/${ids.classA}/notebook-submissions/${submitted.id}/download`,
    );
    expect(notebookLink.status).toBe(200);
    const snapshot = await fetchContent(notebookLink.body.url);
    expect(snapshot.statusCode).toBe(200);
    expect(JSON.parse(snapshot.body)).toMatchObject({ cells: notebook.notebook.cells });
    const fileLink = await call(
      relay,
      priya,
      'GET',
      `/api/classes/${ids.classA}/notebook-submissions/${submitted.id}/files/${fileId}/download`,
    );
    expect(fileLink.status).toBe(200);
    const file = await fetchContent(fileLink.body.url);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('mean\n0.6\n');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="results\.csv"/);

    // No route lets the instructor reach the student's session, its workspace or its transfers.
    for (const path of ['', '/files', '/transfers', `/transfers/${fileId}/download`]) {
      expect((await call(relay, priya, 'GET', `${s.url}${path}`)).status).toBe(404);
    }
    expect(s.connector.received.length).toBe(seen);
  });

  test('A35 no hidden test material is sent to a connector', async () => {
    const s = await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    // The notebook names three files: its released data, a hidden grading check of the course
    // that was not released with it, and an object that does not exist. Only the first is offered.
    const files = await call(relay, cookie, 'GET', `${s.url}/files`);
    expect(files.status).toBe(200);
    expect(files.body.declared).toEqual([
      { path: 'data/sample.csv', size: DATA_CSV.length, sha256: expect.any(String) },
    ]);

    const copied = await call(relay, cookie, 'POST', `${s.url}/transfers`, { kind: 'copy_in' });
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(copied.body.transfers).toEqual([
      expect.objectContaining({ path: 'data/sample.csv', state: 'done', outcome: 'copied' }),
    ]);
    expect([...s.jupyter.files.keys()]).toEqual(['data/sample.csv']);

    // Everything the relay wrote to the connector, control messages and frames alike, is free of
    // the hidden material, and the only file written is the declared one.
    const writes = s.jupyter.contentsRequests.filter((r) => r.method === 'PUT');
    expect(writes.map((w) => w.path)).toEqual(['data', 'data/sample.csv']);
    const hidden = HIDDEN_CHECKS.toString('base64');
    const everything = [
      ...s.connector.received.map((m) => JSON.stringify(m)),
      ...s.connector.frames.map((f) => f.toString('utf8')),
    ].join('\n');
    expect(everything).not.toContain(hidden);
    expect(everything).not.toContain('hidden grading check');
    expect(everything).not.toContain(notebook.hiddenKey);
  });

  test("A35 A10 an instructor cannot download another instructor's submission", async () => {
    const [row] = await testDb.db
      .insert(notebookSubmissions)
      .values({
        classId: ids.classA,
        userId: ids.noor,
        resourceId: notebook.resourceId,
        resourceRevisionId: notebook.revisionId,
        version: 1,
        submissionKey: 'a35-instructor-key',
        objectKey: notebook.dataKey,
        sha256: 'a'.repeat(64),
        size: 1,
        filename: 'instructor.ipynb',
        createdAt: relay.now(),
      })
      .returning({ id: notebookSubmissions.id });
    const path = `/api/classes/${ids.classA}/notebook-submissions/${row?.id}/download`;
    const { priya, noor } = relay.world.cookie;
    expect((await call(relay, noor, 'GET', path)).status).toBe(200);
    expect((await call(relay, priya, 'GET', path)).status).toBe(404);

    // Removed, the instructor's work stays out of review and out of download alike.
    const removed = await removeMember(
      testDb.db,
      asManagerScope(ids.classA, ids.statistics, ids.elena),
      ids.noor,
      relay.now(),
    );
    expect(removed.ok).toBe(true);
    expect((await call(relay, priya, 'GET', path)).status).toBe(404);
  });
});
