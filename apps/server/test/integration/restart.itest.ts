import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { notebookSessions } from '../../src/db/schema';
import { createTestDatabase, type TestDatabase } from './db';
import {
  drained,
  execute,
  executionRows,
  KERNEL,
  kernelMessage,
  openChannel,
  readySession,
} from './kernel-channel';
import { call, insertNotebook } from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * Kernel operations and restarts (docs/design/connector.md §7, §10.6): the typed operations
 * send exactly the allowlisted Jupyter calls, a restart increases the generation and aborts
 * unfinished executions without running anything again, and the operations are the caller's
 * own (A33).
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
let revisionId: string;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
  revisionId = await insertNotebook(testDb.db, start);
  cookie = relay.world.cookie.sam;
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

const sessionRow = async (id: string) =>
  (await testDb.db.select().from(notebookSessions).where(eq(notebookSessions.id, id)))[0];

describe('kernel operations', () => {
  test('start sends POST /api/kernels with the kernelspec, opens one channel and records the kernel', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const post = s.jupyter.http.find((h) => h.method === 'POST');
    expect(post).toMatchObject({ purpose: 'session', path: '/api/kernels', body: 'stream' });
    expect(s.jupyter.opened.map((o) => o.path)).toEqual([
      `/api/kernels/${KERNEL}/channels?session_id=${s.sessionId}`,
    ]);
    expect(await sessionRow(s.sessionId)).toMatchObject({
      kernelId: KERNEL,
      kernelName: 'python3',
      kernelGeneration: 1,
    });
    expect((await call(relay, cookie, 'GET', `${s.url}/kernel`)).body).toEqual({
      kernel: { id: KERNEL, name: 'python3', state: 'idle', generation: 1 },
    });
    // A second start while the kernel runs is refused; the person restarts or shuts it down.
    const again = await call(relay, cookie, 'POST', `${s.url}/kernel`, { kernelName: 'python3' });
    expect(again).toMatchObject({ status: 409, body: { error: 'kernel_exists' } });
    // The connector heard that someone acted on the session (§9 activity).
    expect(s.connector.received.filter((m) => m.t === 'activity')).toHaveLength(1);
  });

  test('start is refused before the session is ready', async () => {
    const s = await readySession(relay, testDb, revisionId, { kernel: false });
    await testDb.db
      .update(notebookSessions)
      .set({ state: 'unconfirmed', cause: 'link_lost' })
      .where(eq(notebookSessions.id, s.sessionId));
    const res = await call(relay, cookie, 'POST', `${s.url}/kernel`, { kernelName: 'python3' });
    expect(res).toMatchObject({ status: 409, body: { error: 'not_ready' } });
    expect(s.jupyter.http).toEqual([]);
  });

  test('interrupt and shut down call the kernel endpoints; shut down aborts unfinished work', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    browser.send(execute('while True: pass'));
    await browser.next((m) => m.t === 'execution' && m.state === 'sent');
    const interrupted = await call(relay, cookie, 'POST', `${s.url}/kernel/interrupt`);
    expect(interrupted.status).toBe(200);
    browser.send({ v: 1, t: 'interrupt' });
    await relay.until(
      () =>
        s.jupyter.http.filter((h) => h.path === `/api/kernels/${KERNEL}/interrupt`).length === 2,
      'two interrupts',
    );
    const deleted = await call(relay, cookie, 'DELETE', `${s.url}/kernel`);
    expect(deleted).toMatchObject({ status: 200, body: { kernel: null } });
    expect(
      s.jupyter.http.some((h) => h.method === 'DELETE' && h.path === `/api/kernels/${KERNEL}`),
    ).toBe(true);
    await browser.next((m) => m.t === 'execution' && m.state === 'aborted');
    expect((await sessionRow(s.sessionId))?.kernelId).toBeNull();
    expect((await call(relay, cookie, 'GET', `${s.url}/kernel`)).body).toEqual({ kernel: null });
  });

  test('restart increases the generation, aborts unfinished executions and runs nothing again', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    browser.send(execute('a = 1', crypto.randomUUID(), 'cell-a'));
    browser.send(execute('b = 2', crypto.randomUUID(), 'cell-b'));
    await relay.until(() => s.jupyter.executeRequests.length === 2, 'two execute_requests');
    const first = s.jupyter.executeRequests[0]?.message.header.msg_id as string;
    s.jupyter.emit(kernelMessage('status', first, { execution_state: 'busy' }));
    s.jupyter.emit(kernelMessage('stream', first, { name: 'stdout', text: 'before\n' }));
    const shown = await browser.next('output');
    expect(shown.generation).toBe(1);

    const res = await call(relay, cookie, 'POST', `${s.url}/kernel/restart`);
    expect(res.status).toBe(200);
    expect(res.body.kernel).toMatchObject({ generation: 2, state: 'restarting' });
    expect(s.jupyter.http.filter((h) => h.path === `/api/kernels/${KERNEL}/restart`)).toHaveLength(
      1,
    );
    await browser.next(
      (m) => m.t === 'kernel_state' && m.state === 'restarting' && m.generation === 2,
    );
    await drained(relay, s.connectorId, s.sessionId);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows.map((r) => [r.cellId, r.state, r.kernelGeneration])).toEqual([
      ['cell-a', 'aborted', 1],
      ['cell-b', 'aborted', 1],
    ]);
    expect((await sessionRow(s.sessionId))?.kernelGeneration).toBe(2);

    // The kernel comes back idle; the next cell runs in generation 2 and nothing else was sent.
    s.jupyter.emit(kernelMessage('status', undefined, { execution_state: 'idle' }));
    await browser.next((m) => m.t === 'kernel_state' && m.state === 'idle');
    const ref = crypto.randomUUID();
    browser.send(execute('c = 3', ref, 'cell-c'));
    expect(await browser.next((m) => m.t === 'execution' && m.ref === ref)).toMatchObject({
      generation: 2,
      seq: 3,
    });
    await relay.until(() => s.jupyter.executeRequests.length === 3, 'the third execute_request');
    expect(s.jupyter.executeRequests.map((r) => r.message.content.code)).toEqual([
      'a = 1',
      'b = 2',
      'c = 3',
    ]);
    const listed = await call(relay, cookie, 'GET', `${s.url}/executions?afterSeq=1`);
    expect(
      listed.body.executions.map((e: { seq: number; state: string }) => [e.seq, e.state]),
    ).toEqual([
      [2, 'aborted'],
      [3, 'sent'],
    ]);
  });

  test('A33 another person cannot reach the kernel, the executions or the channel of a session', async () => {
    const s = await readySession(relay, testDb, revisionId);
    for (const who of ['priya', 'noor', 'bea'] as const) {
      const other = relay.world.cookie[who];
      for (const [method, path] of [
        ['GET', `${s.url}/kernel`],
        ['POST', `${s.url}/kernel/interrupt`],
        ['POST', `${s.url}/kernel/restart`],
        ['DELETE', `${s.url}/kernel`],
        ['GET', `${s.url}/executions`],
      ] as const) {
        const res = await call(relay, other, method, path);
        expect(res, `${who} ${method} ${path}`).toMatchObject({
          status: 404,
          body: { error: 'not found' },
        });
      }
    }
    expect(s.jupyter.http.filter((h) => h.method !== 'POST' || h.path !== '/api/kernels')).toEqual(
      [],
    );
  });
});
