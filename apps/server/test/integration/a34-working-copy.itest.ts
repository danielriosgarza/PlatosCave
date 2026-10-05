import { createHash } from 'node:crypto';
import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  fileTransfers,
  notebookSessions,
  notebookSubmissionFiles,
  notebookSubmissions,
  notebookWorkingCopyRevisions,
} from '../../src/db/schema';
import type { Storage } from '../../src/storage/storage';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import {
  drained,
  execute,
  kernelMessage,
  openChannel,
  type ReadySession,
  readySession,
} from './kernel-channel';
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
 * A34 (spec §10.5, docs/design/connector.md §11): a notebook creates a remote output file.
 * Saving to Parallax does not claim to have uploaded that file or saved kernel memory. Explicit
 * transfer detects conflicting revisions; submission includes only acknowledged, selected files.
 * Each test runs a real link with the fake connector and its fake Jupyter workspace.
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

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function session(kernel = false) {
  const s = await readySession(relay, testDb, notebook.revisionId, { kernel });
  const copy = await call(relay, cookie, 'GET', workingCopyUrl(notebook.revisionId));
  expect(copy.status).toBe(200);
  return { ...s, copy: copy.body as { id: string; currentRevision: number } };
}

const transfer = (s: ReadySession, body: object) =>
  call(relay, cookie, 'POST', `${s.url}/transfers`, body);

const save = (copyId: string, baseRevision: number, notebookJson: object) =>
  call(
    relay,
    cookie,
    'PUT',
    `/api/classes/${ids.classA}/notebook-working-copies/${copyId}/revisions`,
    {
      baseRevision,
      notebook: notebookJson,
    },
  );

describe('A34 working copies and transfer', () => {
  test('A34 saving to Parallax does not claim the remote file was uploaded', async () => {
    const s = await session();
    // The code wrote an output file in the workspace.
    s.jupyter.files.set('results.csv', Buffer.from('mean\n0.6\n'));
    const before = s.jupyter.http.length;

    const saved = await save(s.copy.id, s.copy.currentRevision, {
      ...notebook.notebook,
      cells: [
        ...notebook.notebook.cells,
        {
          id: 'write',
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          source: "frame.describe().to_csv('results.csv')",
          outputs: [],
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // The acknowledgement is about the notebook revision only.
    expect(Object.keys(saved.body).sort()).toEqual(
      ['currentRevision', 'id', 'notebook', 'revision', 'revisions', 'sourceRevisionId'].sort(),
    );
    expect(saved.body.revision).toMatchObject({ source: 'browser' });
    // Nothing was asked of the connector, nothing was recorded as transferred, and the output
    // file is only on the computer.
    expect(s.jupyter.http.length).toBe(before);
    const transfers = await testDb.db
      .select()
      .from(fileTransfers)
      .where(eq(fileTransfers.sessionId, s.sessionId));
    expect(transfers).toEqual([]);
    const listed = await call(relay, cookie, 'GET', `${s.url}/transfers`);
    expect(listed.body.transfers).toEqual([]);

    // The workspace listing names it as a file there, not as something Parallax holds.
    const files = await call(relay, cookie, 'GET', `${s.url}/files`);
    expect(files.status, JSON.stringify(files.body)).toBe(200);
    expect(files.body).toMatchObject({
      workspace: '/home/student/parallax',
      host: 'login.cluster.example.org',
      dir: '',
    });
    expect(files.body.entries).toContainEqual(
      expect.objectContaining({ path: 'results.csv', type: 'file', size: 9 }),
    );
  });

  test('A34 a conflicting remote revision is detected and not overwritten', async () => {
    const s = await session();
    // The same size as the course's file, different bytes: only the checksum tells them apart.
    const theirs = Buffer.from('x,y\n9,9\n9,9\n', 'utf8');
    s.jupyter.dirs.add('data');
    s.jupyter.files.set('data/sample.csv', theirs);

    const first = await transfer(s, { kind: 'copy_in' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const conflict = first.body.transfers.find(
      (t: { path: string }) => t.path === 'data/sample.csv',
    );
    expect(conflict).toMatchObject({
      direction: 'in',
      kind: 'copy_in',
      state: 'conflict',
      outcome: null,
      sha256: sha(DATA_CSV),
      remote: { sha256: sha(theirs), size: theirs.length },
    });
    // Nothing was written over it.
    expect(s.jupyter.files.get('data/sample.csv')).toEqual(theirs);
    expect(
      s.jupyter.contentsRequests.filter((r) => r.method === 'PUT' && r.path === 'data/sample.csv'),
    ).toEqual([]);

    // Save to computer meets the same rule for a notebook already in the workspace.
    s.jupyter.files.set('repeated-samples.ipynb', Buffer.from('{"edited": "remotely"}'));
    const exported = await transfer(s, {
      kind: 'save',
      revision: s.copy.currentRevision,
      path: 'repeated-samples.ipynb',
    });
    expect(exported.body.transfers[0]).toMatchObject({ kind: 'save', state: 'conflict' });
    expect(s.jupyter.files.get('repeated-samples.ipynb')?.toString()).toBe(
      '{"edited": "remotely"}',
    );

    // Only the person's choice writes: here, keep theirs and save ours beside it.
    const kept = await transfer(s, {
      kind: 'copy_in',
      resolutions: [{ path: 'data/sample.csv', choice: 'save_copy' }],
    });
    expect(
      kept.body.transfers.find((t: { path: string }) => t.path === 'data/sample (parallax).csv'),
    ).toMatchObject({ state: 'done', outcome: 'saved_copy' });
    expect(s.jupyter.files.get('data/sample.csv')).toEqual(theirs);
    expect(s.jupyter.files.get('data/sample (parallax).csv')).toEqual(DATA_CSV);
  });

  test('A34 submission contains only acknowledged selected files', async () => {
    const s = await session();
    s.jupyter.files.set('results.csv', Buffer.from('mean\n0.6\n'));
    s.jupyter.files.set('plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    s.jupyter.files.set('scratch.txt', Buffer.from('not selected'));

    const out = await transfer(s, {
      kind: 'copy_out',
      paths: ['results.csv', 'plot.png', 'gone.csv'],
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const byPath = Object.fromEntries(
      out.body.transfers.map((t: { path: string }) => [t.path, t]),
    ) as Record<string, { id: string; state: string; error: string | null }>;
    expect(byPath['results.csv']).toMatchObject({ state: 'done', direction: 'out' });
    expect(byPath['plot.png']).toMatchObject({ state: 'done' });
    expect(byPath['gone.csv']).toMatchObject({ state: 'failed', error: 'not_found' });
    const copiedIn = await transfer(s, { kind: 'copy_in' });
    const copyIn = copiedIn.body.transfers[0] as { id: string; state: string };
    expect(copyIn.state).toBe('done');

    // An acknowledged revision of the notebook.
    const saved = await save(s.copy.id, s.copy.currentRevision, {
      ...notebook.notebook,
      cells: [
        ...notebook.notebook.cells,
        { id: 'end', cell_type: 'markdown', metadata: {}, source: 'Done' },
      ],
    });
    expect(saved.status).toBe(200);
    const revision = saved.body.revision.revision as number;
    const submitUrl = `/api/classes/${ids.classA}/notebook-working-copies/${s.copy.id}/submit`;
    const submit = (transferIds: string[], key: string, rev = revision) =>
      call(relay, cookie, 'POST', submitUrl, {
        revision: rev,
        sessionId: s.sessionId,
        transferIds,
        submissionKey: key,
      });

    // A failed copy, a copy into the workspace, and a revision never saved are all refused.
    for (const [refused, key] of [
      [[byPath['gone.csv']?.id as string], 'refused-failed-01'],
      [[copyIn.id], 'refused-copyin-01'],
    ] as const) {
      const res = await submit([...refused], key);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    expect((await submit([], 'refused-unsaved-1', revision + 5)).status).toBe(400);
    expect(await testDb.db.select().from(notebookSubmissions)).toEqual([]);

    const receipt = await submit([byPath['results.csv']?.id as string], 'submit-key-0001');
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body).toMatchObject({
      version: 1,
      resourceId: notebook.resourceId,
      resourceRevisionId: notebook.revisionId,
      workingCopyRevision: revision,
      files: [{ path: 'results.csv', size: 9, sha256: sha(Buffer.from('mean\n0.6\n')) }],
    });
    const frozen = await testDb.db
      .select()
      .from(notebookSubmissionFiles)
      .where(eq(notebookSubmissionFiles.submissionId, receipt.body.id));
    expect(frozen.map((f) => f.path)).toEqual(['results.csv']);
    // The frozen notebook is the acknowledged revision's bytes.
    const [submission] = await testDb.db
      .select()
      .from(notebookSubmissions)
      .where(eq(notebookSubmissions.id, receipt.body.id));
    const revisions = await testDb.db
      .select()
      .from(notebookWorkingCopyRevisions)
      .where(eq(notebookWorkingCopyRevisions.workingCopyId, s.copy.id));
    expect(submission?.sha256).toBe(revisions.find((r) => r.revision === revision)?.sha256);
    expect(submission).toMatchObject({ sessionId: s.sessionId, workingCopyId: s.copy.id });

    // The same key again answers the same receipt and adds nothing.
    const again = await submit([byPath['results.csv']?.id as string], 'submit-key-0001');
    expect(again.body.id).toBe(receipt.body.id);
    expect(await testDb.db.select().from(notebookSubmissions)).toHaveLength(1);
  });

  test('A34 kernel memory is not part of a save', async () => {
    const s = await session(true);
    // The kernel holds a variable: a cell ran and finished.
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    const ref = crypto.randomUUID();
    browser.send(execute('secret_state = 41 + 1', ref));
    await relay.until(() => s.jupyter.executeRequests.length === 1, 'the execute_request');
    const msgId = s.jupyter.executeRequests[0]?.message.header.msg_id as string;
    s.jupyter.emit(
      kernelMessage('execute_reply', msgId, { status: 'ok', execution_count: 1 }, 'shell'),
    );
    await browser.next((m) => m.t === 'execution' && m.state === 'ok');
    await drained(relay, s.connectorId, s.sessionId);
    const httpBefore = s.jupyter.http.length;
    const writtenBefore = s.jupyter.written.length;

    const document = {
      ...notebook.notebook,
      cells: [
        {
          id: 'state',
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          source: 'secret_state = 41 + 1',
          outputs: [],
        },
      ],
    };
    const saved = await save(s.copy.id, s.copy.currentRevision, document);
    expect(saved.status).toBe(200);
    // The save is the document sent and nothing else: no request reached the kernel or its
    // server, and the stored revision holds exactly the notebook's cells.
    expect(s.jupyter.http.length).toBe(httpBefore);
    expect(s.jupyter.written.length).toBe(writtenBefore);
    expect(saved.body.notebook).toEqual(document);
    const stored = await storage.storage.get(
      (
        await testDb.db
          .select()
          .from(notebookWorkingCopyRevisions)
          .where(eq(notebookWorkingCopyRevisions.workingCopyId, s.copy.id))
      ).find((r) => r.revision === saved.body.revision.revision)?.objectKey as string,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stored.body) chunks.push(chunk as Buffer);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(document);
  });
});
