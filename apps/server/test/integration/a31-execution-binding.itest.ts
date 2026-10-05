import { eq, notInArray } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { notebookSessions } from '../../src/db/schema';
import { kernelRelays, REPLAY_DRAIN_MS } from '../../src/relay/kernel';
import { LiveLinkRegistry } from '../../src/relay/links';
import { ManualTimers } from '../fixtures/fake-connector';
import { createTestDatabase, type TestDatabase } from './db';
import {
  drained,
  execute,
  executionRows,
  FakeJupyter,
  KERNEL,
  kernelMessage,
  openChannel,
  type ReadySession,
  readySession,
} from './kernel-channel';
import { call, insertNotebook, relink } from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * A31 (docs/design/connector.md §10.6): the network fails after a cell execution request;
 * reconnection queries the same kernel and never executes the cell again; unrecoverable output
 * is labelled incomplete; a lost kernel needs an explicit new one. Every test runs a real link
 * with the fake connector and its fake Jupyter, and a real browser channel.
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

// Links of earlier tests time out; each test starts with no open session.
beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

/** A ready session with a kernel, a browser that said `hello`, and one running execution. */
async function running(code = 'import time; time.sleep(8)') {
  const s = await readySession(relay, testDb, revisionId);
  const browser = await openChannel(relay, cookie, s.sessionId);
  browser.send({ v: 1, t: 'hello' });
  const ready = await browser.next('ready');
  expect(ready.kernel).toMatchObject({ id: KERNEL, state: 'idle' });
  const ref = crypto.randomUUID();
  browser.send(execute(code, ref));
  const sent = await browser.next((m) => m.t === 'execution' && m.ref === ref);
  expect(sent).toMatchObject({ state: 'sent', seq: 1, cellId: 'cell-1' });
  await relay.until(() => s.jupyter.executeRequests.length === 1, 'the execute_request');
  const msgId = s.jupyter.executeRequests[0]?.message.header.msg_id as string;
  s.jupyter.emit(kernelMessage('status', msgId, { execution_state: 'busy' }));
  await browser.next((m) => m.t === 'execution' && m.state === 'running');
  return { ...s, browser, ref, msgId, executionId: sent.executionId as string };
}

/** Drops the connector's link and dials it again, answering kernel queries with `query`. */
async function dropAndRelink(s: ReadySession, query: FakeJupyter['query']) {
  s.connector.close();
  await relay.until(() => relay.links.get(s.connectorId) === undefined, 'the link to drop');
  await relay.until(
    async () => (await executionRows(testDb, s.sessionId)).every((r) => r.state !== 'running'),
    'running executions to become unconfirmed',
  );
  const connector = await relink(relay, s.connectorId, s.key);
  const jupyter = new FakeJupyter(connector);
  jupyter.query = query;
  // The first heartbeat after `hello` lists the session as ready: the relay asks the kernel.
  connector.heartbeat(0, [{ sessionId: s.sessionId, state: 'ready', phase: 'attached' }]);
  await connector.next('heartbeat_ack');
  return { connector, jupyter };
}

describe('A31 execution binding', () => {
  test('A31 a resent execute with the same ref sends one execute_request', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    const ref = crypto.randomUUID();
    browser.send(execute('print(2 + 2)', ref));
    const first = await browser.next((m) => m.t === 'execution' && m.ref === ref);

    // The browser reconnects and resends the same execute, as a client does after a drop.
    browser.close();
    const again = await openChannel(relay, cookie, s.sessionId);
    again.send({ v: 1, t: 'hello' });
    await again.next('ready');
    again.send(execute('print(2 + 2)', ref));
    const answer = await again.next((m) => m.t === 'execution' && m.ref === ref);
    expect(answer.executionId).toBe(first.executionId);
    expect(answer.seq).toBe(first.seq);

    // And once more on the same socket.
    again.send(execute('print(2 + 2)', ref));
    await again.next((m) => m.t === 'execution' && m.ref === ref);
    await drained(relay, s.connectorId, s.sessionId);
    expect(s.jupyter.executeRequests).toHaveLength(1);
    const request = s.jupyter.executeRequests[0]?.message;
    expect(request).toMatchObject({
      header: { msg_type: 'execute_request', session: s.sessionId },
      content: { code: 'print(2 + 2)', allow_stdin: true, stop_on_error: true },
      channel: 'shell',
    });
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientRef: ref,
      msgId: request?.header.msg_id,
      kernelId: KERNEL,
      cellId: 'cell-1',
      resourceRevisionId: revisionId,
    });
    expect(rows[0]?.codeHash).toHaveLength(32);

    // Output and the reply complete it; the execution count comes from the reply.
    const msgId = request?.header.msg_id as string;
    s.jupyter.emit(kernelMessage('status', msgId, { execution_state: 'busy' }));
    s.jupyter.emit(kernelMessage('stream', msgId, { name: 'stdout', text: '4\n' }));
    s.jupyter.emit(
      kernelMessage('execute_reply', msgId, { status: 'ok', execution_count: 1 }, 'shell'),
    );
    const output = await again.next('output');
    expect(output).toMatchObject({
      executionId: first.executionId,
      kind: 'output',
      output: { output_type: 'stream', name: 'stdout', text: '4\n' },
    });
    const done = await again.next((m) => m.t === 'execution' && m.state === 'ok');
    expect(done).toMatchObject({ executionId: first.executionId, executionCount: 1 });
  });

  test('A31 reconnect asks the kernel and never executes again', async () => {
    const s = await running();
    const back = await dropAndRelink(s, 'busy');
    await s.browser.next(
      (m) => m.t === 'execution' && m.state === 'unconfirmed' && m.executionId === s.executionId,
    );
    await relay.until(() => back.jupyter.opened.length === 1, 'the kernel channel to reopen');
    const query = back.jupyter.http.find((h) => h.method === 'GET');
    expect(query?.path).toBe(`/api/kernels/${KERNEL}`);
    // The same Jupyter session id, so Jupyter replays what it buffered meanwhile.
    expect(back.jupyter.opened[0]?.path).toBe(
      `/api/kernels/${KERNEL}/channels?session_id=${s.sessionId}`,
    );
    const resumed = await s.browser.next(
      (m) => m.t === 'execution' && m.state === 'running' && m.executionId === s.executionId,
    );
    expect(resumed.outputsIncomplete).toBe(true);

    back.jupyter.emit(kernelMessage('stream', s.msgId, { name: 'stdout', text: 'done\n' }));
    back.jupyter.emit(
      kernelMessage('execute_reply', s.msgId, { status: 'ok', execution_count: 1 }, 'shell'),
    );
    await s.browser.next((m) => m.t === 'execution' && m.state === 'ok');
    await drained(relay, s.connectorId, s.sessionId);
    // One execute_request across both links; the reconnect only queried.
    expect(s.jupyter.executeRequests.length + back.jupyter.executeRequests.length).toBe(1);
    expect(back.jupyter.http.map((h) => `${h.method} ${h.path}`)).toEqual([
      `GET /api/kernels/${KERNEL}`,
    ]);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'ok', outputsIncomplete: true, executionCount: 1 });
  });

  test('A31 output with an unknown parent is dropped', async () => {
    const s = await running();
    const before = kernelRelays(relay.links)?.dropped.unknown_parent ?? 0;
    s.jupyter.emit(
      kernelMessage('stream', crypto.randomUUID(), { name: 'stdout', text: 'not yours\n' }),
    );
    s.jupyter.emit(kernelMessage('display_data', undefined, { data: { 'text/plain': 'x' } }));
    s.jupyter.emit(kernelMessage('stream', s.msgId, { name: 'stdout', text: 'mine\n' }));
    const output = await s.browser.next('output');
    expect(output.output.text).toBe('mine\n');
    await drained(relay, s.connectorId, s.sessionId);
    const outputs = s.browser.received.filter((m) => m.t === 'output');
    expect(outputs.map((m) => m.output.text)).toEqual(['mine\n']);
    expect(kernelRelays(relay.links)?.dropped.unknown_parent).toBe(before + 2);
  });

  test('A31 output from a restarted kernel generation is dropped', async () => {
    const s = await running();
    const restarted = await call(relay, cookie, 'POST', `${s.url}/kernel/restart`);
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    expect(restarted.body.kernel).toMatchObject({ id: KERNEL, generation: 2 });
    const aborted = await s.browser.next((m) => m.t === 'execution' && m.state === 'aborted');
    expect(aborted.generation).toBe(1);
    await s.browser.next((m) => m.t === 'kernel_state' && m.generation === 2);

    // Late output of the execution that belonged to generation 1.
    s.jupyter.emit(kernelMessage('stream', s.msgId, { name: 'stdout', text: 'late\n' }));
    s.jupyter.emit(
      kernelMessage('execute_reply', s.msgId, { status: 'ok', execution_count: 1 }, 'shell'),
    );
    await drained(relay, s.connectorId, s.sessionId);
    expect(s.browser.received.filter((m) => m.t === 'output')).toEqual([]);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows[0]).toMatchObject({ state: 'aborted', kernelGeneration: 1 });
    expect(s.jupyter.executeRequests).toHaveLength(1);
  });

  test('A31 lost kernel needs an explicit new session', async () => {
    const s = await running();
    const back = await dropAndRelink(s, 404);
    const incomplete = await s.browser.next((m) => m.t === 'execution' && m.state === 'incomplete');
    expect(incomplete).toMatchObject({ executionId: s.executionId, outputsIncomplete: true });
    await s.browser.next((m) => m.t === 'session_state' && m.cause === 'kernel_lost');
    const [row] = await testDb.db
      .select()
      .from(notebookSessions)
      .where(eq(notebookSessions.id, s.sessionId));
    expect(row).toMatchObject({ state: 'ready', cause: 'kernel_lost', kernelId: null });
    expect((await call(relay, cookie, 'GET', `${s.url}/kernel`)).body).toEqual({ kernel: null });

    // Nothing runs until a new kernel is started explicitly.
    const ref = crypto.randomUUID();
    s.browser.send(execute('x', ref));
    expect(await s.browser.next((m) => m.t === 'error' && m.ref === ref)).toMatchObject({
      code: 'not_ready',
    });
    expect(back.jupyter.executeRequests).toEqual([]);
    expect(back.jupyter.opened).toEqual([]);

    back.jupyter.kernelId = '1e3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f';
    const started = await call(relay, cookie, 'POST', `${s.url}/kernel`, { kernelName: 'python3' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.kernel).toMatchObject({ id: back.jupyter.kernelId, generation: 2 });
    const [after] = await testDb.db
      .select()
      .from(notebookSessions)
      .where(eq(notebookSessions.id, s.sessionId));
    expect(after?.cause).toBeNull();
    const next = crypto.randomUUID();
    s.browser.send(execute('x = 1', next));
    expect(await s.browser.next((m) => m.t === 'execution' && m.ref === next)).toMatchObject({
      state: 'sent',
      seq: 2,
      generation: 2,
    });
    await relay.until(() => back.jupyter.executeRequests.length === 1, 'the new execute_request');
    expect(back.jupyter.executeRequests[0]?.message.content.code).toBe('x = 1');
  });

  test('A31 an unrecoverable gap is incomplete', async () => {
    const s = await running();
    const back = await dropAndRelink(s, 'idle');
    await relay.until(() => back.jupyter.opened.length === 1, 'the kernel channel to reopen');
    await drained(relay, s.connectorId, s.sessionId);
    expect((await executionRows(testDb, s.sessionId))[0]?.state).toBe('unconfirmed');
    // The replay brings nothing for the execution; after 2 s of quiet its outcome is unknown.
    relay.advance(REPLAY_DRAIN_MS);
    const incomplete = await s.browser.next((m) => m.t === 'execution' && m.state === 'incomplete');
    expect(incomplete).toMatchObject({ executionId: s.executionId, outputsIncomplete: true });
    await drained(relay, s.connectorId, s.sessionId);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows[0]).toMatchObject({ state: 'incomplete', outputsIncomplete: true });
    expect(s.jupyter.executeRequests.length + back.jupyter.executeRequests.length).toBe(1);
  });

  test('A31 a cell run during the replay window is live, however quiet it is', async () => {
    const s = await running();
    const back = await dropAndRelink(s, 'idle');
    await relay.until(() => back.jupyter.opened.length === 1, 'the kernel channel to reopen');
    await drained(relay, s.connectorId, s.sessionId);
    // A new cell inside the 2 s window that prints nothing for longer than the window.
    const ref = crypto.randomUUID();
    s.browser.send(execute('import time; time.sleep(5)', ref, 'cell-2'));
    const sent = await s.browser.next((m) => m.t === 'execution' && m.ref === ref);
    expect(sent).toMatchObject({ state: 'sent', seq: 2 });
    await relay.until(() => back.jupyter.executeRequests.length === 1, 'the new execute_request');
    relay.advance(REPLAY_DRAIN_MS);
    // Only the execution that was in flight when the link dropped is incomplete.
    const incomplete = await s.browser.next((m) => m.t === 'execution' && m.state === 'incomplete');
    expect(incomplete.executionId).toBe(s.executionId);
    await drained(relay, s.connectorId, s.sessionId);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows.map((r) => [r.seq, r.state])).toEqual([
      [1, 'incomplete'],
      [2, 'sent'],
    ]);
    const msgId = back.jupyter.executeRequests[0]?.message.header.msg_id as string;
    back.jupyter.emit(kernelMessage('status', msgId, { execution_state: 'busy' }));
    back.jupyter.emit(kernelMessage('stream', msgId, { name: 'stdout', text: 'woke\n' }));
    back.jupyter.emit(
      kernelMessage('execute_reply', msgId, { status: 'ok', execution_count: 2 }, 'shell'),
    );
    expect((await s.browser.next('output')).output.text).toBe('woke\n');
    expect(
      await s.browser.next((m) => m.t === 'execution' && m.ref === ref && m.state === 'ok'),
    ).toMatchObject({ executionCount: 2, outputsIncomplete: false });
  });

  test('A31 a reply in the replay of an idle kernel completes the execution', async () => {
    const s = await running();
    const back = await dropAndRelink(s, 'idle');
    await relay.until(() => back.jupyter.opened.length === 1, 'the kernel channel to reopen');
    back.jupyter.emit(
      kernelMessage('execute_reply', s.msgId, { status: 'error', execution_count: 4 }, 'shell'),
    );
    const done = await s.browser.next((m) => m.t === 'execution' && m.state === 'error');
    expect(done).toMatchObject({ executionCount: 4, outputsIncomplete: true });
    relay.advance(REPLAY_DRAIN_MS);
    await drained(relay, s.connectorId, s.sessionId);
    expect((await executionRows(testDb, s.sessionId))[0]?.state).toBe('error');
  });

  test('A31 a failed write leaves the execution unconfirmed', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    // The connector grants no more credit, so a cell larger than the 256 KiB window stalls
    // half written; the kernel query that follows the loss is held.
    s.jupyter.credit = false;
    s.jupyter.query = 'hold';
    const big = `x = '${'a'.repeat(300 * 1024)}'`;
    const ref = crypto.randomUUID();
    browser.send(execute(big, ref));
    await browser.next((m) => m.t === 'execution' && m.ref === ref && m.state === 'sent');
    // The connector ends the channel while the request is half written.
    s.jupyter.resetChannel();
    const unconfirmed = await browser.next(
      (m) => m.t === 'execution' && m.ref === ref && m.state === 'unconfirmed',
    );
    expect(unconfirmed.seq).toBe(1);
    await drained(relay, s.connectorId, s.sessionId);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('unconfirmed');
    // Nothing is sent again: no complete execute_request reached the connector, and the only
    // request since is the kernel query.
    expect(s.jupyter.executeRequests).toEqual([]);
    await relay.until(
      () => s.jupyter.http.some((h) => h.method === 'GET'),
      'the kernel to be asked again',
    );
    expect(s.jupyter.opened).toHaveLength(1);
  });

  test('A31 a relay restart makes running executions unconfirmed', async () => {
    const s = await running();
    // A second relay process on the same database: it held nothing, so it trusts nothing.
    const links = new LiveLinkRegistry({
      db: testDb.db,
      origin: relay.origin,
      now: relay.now,
      log: pino({ level: 'silent' }),
      timers: new ManualTimers(),
    });
    const other = await buildApp(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', CONTENT_HOST: 'content.invalid' }),
      { db: testDb.db, now: relay.now, mode: 'relay', links },
    );
    await other.ready();
    await kernelRelays(links)?.settled(s.sessionId);
    const rows = await executionRows(testDb, s.sessionId);
    expect(rows[0]).toMatchObject({ id: s.executionId, state: 'unconfirmed' });
    await relay.until(async () => {
      const [session] = await testDb.db
        .select()
        .from(notebookSessions)
        .where(eq(notebookSessions.id, s.sessionId));
      return session?.state === 'unconfirmed';
    }, 'the session to be unconfirmed');
    await other.close();
  });
});
