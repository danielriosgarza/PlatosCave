import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  notebookSessions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
} from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { readySession } from './kernel-channel';
import { call } from './notebook-sessions';
import { type Relay, startRelay } from './relay';
import {
  type ConnectedNotebook,
  connectedNotebook,
  tempStorage,
  workingCopyUrl,
} from './working-copies';

/**
 * Working copies (docs/design/connector.md §11): the first Connect makes one, revision 1 being
 * the course notebook; a save names the revision it edited, and a stale one is refused with the
 * current copy, overwriting nothing (ADR-0003).
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

const edited = (text: string) => ({
  ...notebook.notebook,
  cells: [
    ...notebook.notebook.cells,
    { id: 'mine', cell_type: 'markdown', metadata: {}, source: text },
  ],
});

describe('working copies', () => {
  test('the first Connect makes the working copy once; revision 1 is the course notebook', async () => {
    expect((await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId))).status).toBe(
      404,
    );
    const first = await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    const copy = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body).toMatchObject({
      sourceRevisionId: notebook.revisionId,
      currentRevision: 1,
      revision: { revision: 1, source: 'server' },
      notebook: { cells: notebook.notebook.cells, metadata: notebook.notebook.metadata },
    });
    const [session] = await testDb.db
      .select()
      .from(notebookSessions)
      .where(eq(notebookSessions.id, first.sessionId));
    expect(session?.workingCopyId).toBe(copy.body.id);

    // Connecting again (a later session) keeps the same copy.
    relay.advance(61_000);
    await testDb.db
      .update(notebookSessions)
      .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
      .where(eq(notebookSessions.id, first.sessionId));
    const second = await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    const copies = await testDb.db
      .select()
      .from(notebookWorkingCopies)
      .where(eq(notebookWorkingCopies.userId, ids.sam));
    expect(copies).toHaveLength(1);
    const [again] = await testDb.db
      .select()
      .from(notebookSessions)
      .where(eq(notebookSessions.id, second.sessionId));
    expect(again?.workingCopyId).toBe(copy.body.id);
  });

  test('a save with a stale base revision is 409 revision_conflict carrying the current copy', async () => {
    await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    const copy = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
    const base = copy.body.currentRevision as number;
    const save = (baseRevision: number, text: string) =>
      call(
        relay,
        cookie,
        'PUT',
        `/api/classes/${ids.classA}/notebook-working-copies/${copy.body.id}/revisions`,
        {
          baseRevision,
          notebook: edited(text),
        },
      );

    const saved = await save(base, 'from tab one');
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      currentRevision: base + 1,
      revision: { revision: base + 1, source: 'browser' },
    });

    // A second tab still editing the old base.
    const stale = await save(base, 'from tab two');
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: 'revision_conflict',
      current: { currentRevision: base + 1, revision: { revision: base + 1 } },
    });
    expect(JSON.stringify(stale.body.current.notebook)).toContain('from tab one');
    expect(JSON.stringify(stale.body.current.notebook)).not.toContain('from tab two');
    const revisions = await testDb.db
      .select()
      .from(notebookWorkingCopyRevisions)
      .where(eq(notebookWorkingCopyRevisions.workingCopyId, copy.body.id));
    expect(revisions.map((r) => r.revision).sort()).toEqual(
      Array.from({ length: base + 1 }, (_, i) => i + 1),
    );

    // An earlier revision stays readable.
    const old = await call(
      relay,
      cookie,
      'GET',
      `${workingCopyUrl(notebook.revisionId)}?revision=1`,
    );
    expect(old.body.revision.revision).toBe(1);
    expect(JSON.stringify(old.body.notebook)).not.toContain('from tab one');
  });

  test('a save that is not a valid notebook is refused and stores no revision', async () => {
    await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    const copy = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
    const res = await call(
      relay,
      cookie,
      'PUT',
      `/api/classes/${ids.classA}/notebook-working-copies/${copy.body.id}/revisions`,
      { baseRevision: copy.body.currentRevision, notebook: { nbformat: 3, cells: [] } },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid');
    const after = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
    expect(after.body.currentRevision).toBe(copy.body.currentRevision);
  });

  test('another person’s working copy is the shared 404, for the class instructor too', async () => {
    await readySession(relay, testDb, notebook.revisionId, { kernel: false });
    const copy = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
    for (const who of ['priya', 'noor'] as const) {
      const other = relay.world.cookie[who];
      expect((await call(relay, other, 'GET', workingCopyUrl(notebook.revisionId))).status).toBe(
        404,
      );
      const save = await call(
        relay,
        other,
        'PUT',
        `/api/classes/${ids.classA}/notebook-working-copies/${copy.body.id}/revisions`,
        { baseRevision: copy.body.currentRevision, notebook: edited('not mine') },
      );
      expect(save.status).toBe(404);
    }
    // Bea is in class B: class A is not hers at all.
    const bea = relay.world.cookie.bea;
    expect((await call(relay, bea, 'GET', workingCopyUrl(notebook.revisionId))).status).toBe(404);
  });
});
