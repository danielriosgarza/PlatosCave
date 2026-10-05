import { and, eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, fileTransfers, notebookSessions } from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import { type ReadySession, readySession } from './kernel-channel';
import { call } from './notebook-sessions';
import { type Relay, startRelay } from './relay';
import {
  type ConnectedNotebook,
  connectedNotebook,
  DATA_CSV,
  tempStorage,
  workingCopyUrl,
} from './working-copies';

/**
 * File transfer (docs/design/connector.md §7, §11): the choices for a divergent file, the copy-out
 * limits, confinement to the workspace, imports, and copied files served as attachments from the
 * content origin.
 */

const MiB = 1024 * 1024;
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

const ready = (options: Parameters<typeof readySession>[3] = {}) =>
  readySession(relay, testDb, notebook.revisionId, { kernel: false, ...options });

const transfer = (s: ReadySession, body: object, who = cookie) =>
  call(relay, who, 'POST', `${s.url}/transfers`, body);

const workingCopy = async () =>
  (await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId))).body;

describe('transfers', () => {
  test('a divergent file waits for a choice: keep theirs, replace, or save mine as a copy', async () => {
    const s = await ready();
    const theirs = Buffer.from('x,y\n0,0\n');
    s.jupyter.dirs.add('data');
    s.jupyter.files.set('data/sample.csv', theirs);
    const conflict = await transfer(s, { kind: 'copy_in' });
    // Another size: a conflict found without reading the file.
    expect(conflict.body.transfers[0]).toMatchObject({
      state: 'conflict',
      remote: { sha256: '', size: theirs.length },
    });
    expect(
      s.jupyter.contentsRequests.filter(
        (r) => r.path === 'data/sample.csv' && r.query.get('content') === '1',
      ),
    ).toEqual([]);

    const kept = await transfer(s, {
      kind: 'copy_in',
      resolutions: [{ path: 'data/sample.csv', choice: 'keep_theirs' }],
    });
    expect(kept.body.transfers[0]).toMatchObject({ state: 'done', outcome: 'kept_theirs' });
    expect(s.jupyter.files.get('data/sample.csv')).toEqual(theirs);

    // A copy's name already holding another file is not overwritten either.
    s.jupyter.files.set('data/sample (parallax).csv', Buffer.from('someone else'));
    const blocked = await transfer(s, {
      kind: 'copy_in',
      resolutions: [{ path: 'data/sample.csv', choice: 'save_copy' }],
    });
    expect(blocked.body.transfers[0]).toMatchObject({
      path: 'data/sample (parallax).csv',
      state: 'failed',
      error: 'copy_exists',
    });
    expect(s.jupyter.files.get('data/sample (parallax).csv')?.toString()).toBe('someone else');

    const replaced = await transfer(s, {
      kind: 'copy_in',
      resolutions: [{ path: 'data/sample.csv', choice: 'replace' }],
    });
    expect(replaced.body.transfers[0]).toMatchObject({ state: 'done', outcome: 'replaced' });
    expect(s.jupyter.files.get('data/sample.csv')).toEqual(DATA_CSV);

    // Now the same file is there: nothing is written, whatever was chosen before.
    const puts = s.jupyter.contentsRequests.filter((r) => r.method === 'PUT').length;
    const same = await transfer(s, { kind: 'copy_in' });
    expect(same.body.transfers[0]).toMatchObject({ state: 'done', outcome: 'unchanged' });
    expect(s.jupyter.contentsRequests.filter((r) => r.method === 'PUT').length).toBe(puts);

    const audited = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'transfer.copied_in'), eq(auditEvents.actorId, ids.sam)));
    // Only the replace wrote anything.
    expect(audited).toHaveLength(1);
  });

  test('copy-out keeps to 25 MiB a file and 200 MiB a session, reading nothing over a limit', async () => {
    const s = await ready();
    s.jupyter.reportedSizes.set('huge.bin', 25 * MiB + 1);
    s.jupyter.reportedSizes.set('big.bin', 20 * MiB);
    s.jupyter.files.set('small.txt', Buffer.from('ok'));
    s.jupyter.dirs.add('outputs');

    const first = await transfer(s, {
      kind: 'copy_out',
      paths: ['huge.bin', 'outputs', 'small.txt'],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.transfers).toEqual([
      expect.objectContaining({ path: 'huge.bin', state: 'failed', error: 'too_large' }),
      expect.objectContaining({ path: 'outputs', state: 'failed', error: 'not_a_file' }),
      expect.objectContaining({ path: 'small.txt', state: 'done', size: 2 }),
    ]);
    // The oversized file was only asked for its size.
    const reads = s.jupyter.contentsRequests.filter((r) => r.path === 'huge.bin');
    expect(reads.every((r) => r.query.get('content') === '0')).toBe(true);

    // 190 MiB already stored from this session: a 20 MiB file would pass the budget.
    await testDb.db.insert(fileTransfers).values({
      classId: ids.classA,
      sessionId: s.sessionId,
      userId: ids.sam,
      direction: 'out',
      path: 'earlier.bin',
      sha256: 'f'.repeat(64),
      size: 190 * MiB,
      state: 'done',
      objectKey: `classes/${ids.classA}/transfers/objects/${'f'.repeat(64)}`,
      conflict: { kind: 'copy_out', outcome: 'copied' },
      createdAt: relay.now(),
      finishedAt: relay.now(),
    });
    const second = await transfer(s, { kind: 'copy_out', paths: ['big.bin'] });
    expect(second.body.transfers).toEqual([
      expect.objectContaining({ path: 'big.bin', state: 'failed', error: 'session_limit' }),
    ]);
  });

  test('paths stay inside the workspace and hidden names are not offered', async () => {
    const s = await ready();
    s.jupyter.files.set('notes.txt', Buffer.from('n'));
    s.jupyter.files.set('.bash_history', Buffer.from('secret'));
    for (const path of [
      '../etc/passwd',
      '/etc/passwd',
      '.ssh/id_ed25519',
      'a/../b',
      'a//b',
      'a\\b',
    ]) {
      const out = await transfer(s, { kind: 'copy_out', paths: [path] });
      expect(out.status, path).toBe(400);
      const save = await transfer(s, { kind: 'save', revision: 1, path: `${path}.ipynb` });
      expect(save.status, path).toBe(400);
    }
    expect((await call(relay, cookie, 'GET', `${s.url}/files?dir=..`)).status).toBe(400);
    expect((await call(relay, cookie, 'GET', `${s.url}/files?dir=.ssh`)).status).toBe(400);
    expect(s.jupyter.contentsRequests).toEqual([]);

    const listed = await call(relay, cookie, 'GET', `${s.url}/files`);
    expect(listed.body.entries.map((e: { name: string }) => e.name)).toEqual(['notes.txt']);
    // Every request the relay built names a path inside the workspace.
    expect(
      s.jupyter.contentsRequests.every((r) => !r.path.split('/').some((p) => p.startsWith('.'))),
    ).toBe(true);
  });

  test('a copied-out file is served as an attachment from the content origin, to its owner only', async () => {
    const s = await ready();
    s.jupyter.files.set('report.html', Buffer.from('<script>alert(1)</script>'));
    const out = await transfer(s, { kind: 'copy_out', paths: ['report.html'] });
    const id = out.body.transfers[0].id as string;
    expect((await call(relay, cookie, 'GET', `${s.url}/transfers/${id}`)).body).toMatchObject({
      id,
      state: 'done',
      kind: 'copy_out',
    });
    const link = await call(relay, cookie, 'GET', `${s.url}/transfers/${id}/download`);
    expect(link.status).toBe(200);
    const url = new URL(link.body.url);
    expect(url.host).toBe('content.invalid:3000');
    const served = await relay.app.inject({
      method: 'GET',
      url: url.pathname,
      headers: { host: url.host },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toMatch(/^attachment; filename="report\.html"/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    // The app origin never serves it, and nobody else gets a link.
    for (const who of ['priya', 'noor'] as const) {
      expect(
        (await call(relay, relay.world.cookie[who], 'GET', `${s.url}/transfers/${id}/download`))
          .status,
      ).toBe(404);
    }
  });

  test('an import becomes a new revision after its base, only as a valid notebook', async () => {
    const s = await ready();
    const copy = await workingCopy();
    const remote = {
      ...notebook.notebook,
      cells: [
        { id: 'remote', cell_type: 'markdown', metadata: {}, source: 'Edited in JupyterLab' },
      ],
    };
    s.jupyter.files.set('edited.ipynb', Buffer.from(JSON.stringify(remote)));
    s.jupyter.files.set('broken.ipynb', Buffer.from('{"nbformat": 3}'));

    const broken = await transfer(s, {
      kind: 'import',
      path: 'broken.ipynb',
      baseRevision: copy.currentRevision,
    });
    expect(broken.status).toBe(400);
    expect((await workingCopy()).currentRevision).toBe(copy.currentRevision);

    const stale = await transfer(s, {
      kind: 'import',
      path: 'edited.ipynb',
      baseRevision: copy.currentRevision + 3,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: 'revision_conflict',
      current: { currentRevision: copy.currentRevision },
    });

    const imported = await transfer(s, {
      kind: 'import',
      path: 'edited.ipynb',
      baseRevision: copy.currentRevision,
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body.transfers[0]).toMatchObject({
      kind: 'import',
      direction: 'out',
      state: 'done',
      revision: copy.currentRevision + 1,
    });
    expect(imported.body.workingCopy).toMatchObject({
      currentRevision: copy.currentRevision + 1,
      revision: { source: 'import' },
      notebook: { cells: remote.cells },
    });
    // An import is not a copied-out file: it cannot be submitted as one.
    const submit = await call(
      relay,
      cookie,
      'POST',
      `/api/classes/${ids.classA}/notebook-working-copies/${copy.id}/submit`,
      {
        revision: copy.currentRevision + 1,
        sessionId: s.sessionId,
        transferIds: [imported.body.transfers[0].id],
        submissionKey: 'import-key-001',
      },
    );
    expect(submit.status).toBe(400);
  });

  test('transfers need a ready session the server can place, on a live link', async () => {
    // An attached Jupyter server's root is not known to the relay.
    const attached = await ready({
      connection: { runtime: { mode: 'attach', port: 8888, kernelName: 'python3' } },
      report: { owned: false },
    });
    const refused = await transfer(attached, { kind: 'copy_in' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'workspace_unknown' });
    expect(attached.jupyter.contentsRequests).toEqual([]);

    relay.advance(61_000);
    await testDb.db
      .update(notebookSessions)
      .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
      .where(eq(notebookSessions.id, attached.sessionId));
    const s = await ready();
    s.connector.close();
    await relay.until(() => relay.links.get(s.connectorId) === undefined, 'the link to drop');
    const offline = await transfer(s, { kind: 'copy_out', paths: ['x.csv'] });
    expect(offline.status).toBe(409);
    expect(['connector_offline', 'not_ready']).toContain(offline.body.error);

    // Someone else's session is the shared 404.
    expect((await transfer(s, { kind: 'copy_in' }, relay.world.cookie.priya)).status).toBe(404);
    expect((await call(relay, relay.world.cookie.priya, 'GET', `${s.url}/files`)).status).toBe(404);
  });
});
