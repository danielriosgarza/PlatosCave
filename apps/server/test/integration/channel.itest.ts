import { and, eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSession, revokeSession } from '../../src/db/auth/sessions';
import { classMemberships, notebookSessions } from '../../src/db/schema';
import { MESSAGES_PER_SECOND, REVALIDATE_MS } from '../../src/relay/channel';
import { EXECUTES_PER_SECOND } from '../../src/relay/kernel';
import { cookieFor, ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import {
  APP_ORIGIN,
  channelPath,
  drained,
  execute,
  kernelMessage,
  openChannel,
  readySession,
  upgradeStatus,
} from './kernel-channel';
import { insertNotebook, keepAlive } from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * The browser channel (docs/design/connector.md §10.1, §10.5): the upgrade checks the scope, the
 * session's owner and `Origin`; the scope is re-validated every 60 s and before every message
 * that names a resource, so a revoked sign-in or a removed membership closes the socket; rate
 * limits answer `rate_limited`; presence follows the attached browsers; a resumed browser gets
 * what it missed.
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

describe('browser channel', () => {
  test('the upgrade needs the app origin, the class and the caller’s own session', async () => {
    const s = await readySession(relay, testDb, revisionId, { kernel: false });
    const path = channelPath(ids.classA, s.sessionId);
    expect(await upgradeStatus(relay, path, { cookie, origin: APP_ORIGIN })).toBe(101);
    // A refusal is never an upgrade. @fastify/websocket destroys the socket once the refusal is
    // answered, which can cut off the status line, so a hang-up (0) also counts as refused.
    const refused = async (headers: Record<string, string>, status: number, other = path) =>
      expect([status, 0]).toContain(await upgradeStatus(relay, other, headers));
    // Cross-site WebSocket hijacking: another origin, or none, is refused before the upgrade.
    await refused({ cookie, origin: 'https://evil.example' }, 403);
    await refused({ cookie }, 403);
    // Without a sign-in, outside the class, or not the owner: refused before the upgrade.
    await refused({ origin: APP_ORIGIN }, 401);
    for (const who of ['priya', 'noor', 'bea', 'marcus'] as const) {
      await refused({ cookie: relay.world.cookie[who], origin: APP_ORIGIN }, 404);
    }
    await refused(
      { cookie, origin: APP_ORIGIN },
      404,
      channelPath(ids.classA, crypto.randomUUID()),
    );
    // The refusals opened nothing: only the accepted upgrade attached a browser.
    await drained(relay, s.connectorId, s.sessionId);
    expect(s.connector.received.filter((m) => m.t === 'presence' && m.attached)).toHaveLength(1);
  });

  test('ready describes the session and the kernel; presence follows the attached browsers', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const first = await openChannel(relay, cookie, s.sessionId);
    first.send({ v: 1, t: 'hello' });
    const ready = await first.next('ready');
    expect(ready).toMatchObject({
      v: 1,
      eventSeq: 0,
      session: { state: 'ready', cause: null, owned: true, lease: { idleTimeoutMin: 30 } },
      kernel: { name: 'python3', state: 'idle', generation: 1 },
    });
    await s.connector.next('presence');
    const second = await openChannel(relay, cookie, s.sessionId);
    first.close();
    await first.closed;
    second.close();
    await second.closed;
    await relay.until(
      () => s.connector.received.filter((m) => m.t === 'presence').length === 2,
      'presence false',
    );
    expect(s.connector.received.filter((m) => m.t === 'presence').map((m) => m.attached)).toEqual([
      true,
      false,
    ]);
  });

  test('a resumed browser gets the output it missed; another epoch gets all of it', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    const ready = await browser.next('ready');
    browser.send(execute('for i in range(3): print(i)'));
    await relay.until(() => s.jupyter.executeRequests.length === 1, 'the execute_request');
    const msgId = s.jupyter.executeRequests[0]?.message.header.msg_id as string;
    s.jupyter.emit(kernelMessage('stream', msgId, { name: 'stdout', text: '0\n' }));
    const seen = await browser.next('output');
    browser.close();
    await browser.closed;
    // The browser is away; the relay keeps receiving and buffering.
    s.jupyter.emit(kernelMessage('stream', msgId, { name: 'stdout', text: '1\n' }));
    s.jupyter.emit(kernelMessage('stream', msgId, { name: 'stdout', text: '2\n' }));
    await drained(relay, s.connectorId, s.sessionId);

    const back = await openChannel(relay, cookie, s.sessionId);
    back.send({ v: 1, t: 'hello', resume: { epoch: ready.epoch, afterEventSeq: seen.eventSeq } });
    expect(await back.next('ready')).toMatchObject({ epoch: ready.epoch, eventSeq: 3 });
    expect((await back.next('output')).output.text).toBe('1\n');
    expect((await back.next('output')).output.text).toBe('2\n');

    const fresh = await openChannel(relay, cookie, s.sessionId);
    fresh.send({ v: 1, t: 'hello', resume: { epoch: crypto.randomUUID(), afterEventSeq: 3 } });
    await fresh.next('ready');
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await fresh.next('output')).output.text);
    expect(texts).toEqual(['0\n', '1\n', '2\n']);
  });

  test('an input prompt belongs to its execution and only its owner may answer it', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    browser.send(execute('name = input("Name? ")'));
    const sent = await browser.next('execution');
    await relay.until(() => s.jupyter.executeRequests.length === 1, 'the execute_request');
    const msgId = s.jupyter.executeRequests[0]?.message.header.msg_id as string;
    s.jupyter.emit(
      kernelMessage('input_request', msgId, { prompt: 'Name? ', password: false }, 'stdin'),
    );
    await browser.next((m) => m.t === 'kernel_state' && m.state === 'waiting_for_input');
    const prompt = await browser.next((m) => m.t === 'output' && m.kind === 'input_request');
    expect(prompt).toMatchObject({
      executionId: sent.executionId,
      input: { prompt: 'Name? ', password: false },
    });
    browser.send({ v: 1, t: 'input_reply', executionId: crypto.randomUUID(), value: 'x' });
    expect(await browser.next('error')).toMatchObject({ code: 'not_waiting_for_input' });
    browser.send({ v: 1, t: 'input_reply', executionId: sent.executionId, value: 'Sam' });
    await relay.until(
      () => s.jupyter.written.some((w) => w.message.header?.msg_type === 'input_reply'),
      'the input reply',
    );
    const reply = s.jupyter.written.find((w) => w.message.header?.msg_type === 'input_reply');
    expect(reply?.message).toMatchObject({ channel: 'stdin', content: { value: 'Sam' } });
  });

  test('more than 30 executes a second are refused with rate_limited', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    for (let i = 0; i <= EXECUTES_PER_SECOND; i++) browser.send(execute(`x = ${i}`));
    expect(await browser.next('error')).toMatchObject({ code: 'rate_limited' });
    await relay.until(
      () => s.jupyter.executeRequests.length === EXECUTES_PER_SECOND,
      'thirty execute_requests',
    );
    // A flood of any message is refused too.
    for (let i = 0; i <= MESSAGES_PER_SECOND; i++) browser.send({ v: 1, t: 'hello' });
    expect(await browser.next((m) => m.t === 'error' && m.code === 'rate_limited')).toBeDefined();
    browser.send({ v: 1, t: 'nonsense' });
    relay.advance(1000);
    browser.send({ v: 1, t: 'nonsense' });
    expect(
      await browser.next((m) => m.t === 'error' && m.code === 'invalid_message'),
    ).toBeDefined();
  });

  test('a session that ends closes its channels', async () => {
    const s = await readySession(relay, testDb, revisionId, { kernel: false });
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    s.connector.send({
      v: 1,
      t: 'session_state',
      sessionId: s.sessionId,
      state: 'stopped',
      owned: true,
      cause: 'lease_idle',
      ts: Math.floor(relay.now().getTime() / 1000),
    });
    expect(await browser.next('session_state')).toMatchObject({
      state: 'stopped',
      cause: 'lease_idle',
    });
    expect(await browser.closed).toEqual({ code: 4410, reason: 'session_closed' });
  });

  test('a revoked sign-in closes the socket at the next re-validation', async () => {
    const s = await readySession(relay, testDb, revisionId, { kernel: false });
    const { token } = await createSession(testDb.db, ids.sam, { now: relay.now() });
    const browser = await openChannel(relay, cookieFor(token), s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    // Still valid at the first re-validation.
    await keepAlive(relay, s.connector, REVALIDATE_MS);
    await drained(relay, s.connectorId, s.sessionId);
    await revokeSession(testDb.db, token, relay.now());
    await keepAlive(relay, s.connector, REVALIDATE_MS);
    expect(await browser.closed).toEqual({ code: 4403, reason: 'scope_lost' });
  });

  test('a removed membership closes the socket before the next execute', async () => {
    const s = await readySession(relay, testDb, revisionId);
    const browser = await openChannel(relay, cookie, s.sessionId);
    browser.send({ v: 1, t: 'hello' });
    await browser.next('ready');
    const where = and(
      eq(classMemberships.classId, ids.classA),
      eq(classMemberships.userId, ids.sam),
    );
    const [membership] = await testDb.db.select().from(classMemberships).where(where);
    if (!membership) throw new Error('Sam is not a member of class A');
    await testDb.db.delete(classMemberships).where(where);
    try {
      browser.send(execute('print("after removal")'));
      expect(await browser.closed).toEqual({ code: 4403, reason: 'scope_lost' });
      expect(s.jupyter.executeRequests).toEqual([]);
    } finally {
      await testDb.db.insert(classMemberships).values(membership);
    }
  });
});
