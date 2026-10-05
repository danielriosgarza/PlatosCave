import { and, eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, notebookSessions } from '../../src/db/schema';
import { START_TIMEOUT_MS, STOP_TIMEOUT_MS } from '../../src/relay/sessions';
import type { FakeConnector, Received } from '../fixtures/fake-connector';
import { ids } from '../fixtures/world';
import { createTestDatabase, type TestDatabase } from './db';
import {
  call,
  insertNotebook,
  keepAlive,
  liveConnector,
  relink,
  saveConnection,
  sessionState,
  settled,
} from './notebook-sessions';
import { type Relay, startRelay } from './relay';

/**
 * Closing and losing notebook sessions (docs/design/connector.md §2, §9, §10.7) over a real link
 * with the fake connector: Disconnect and Stop (A32), and the causes, refusals and Forget of a
 * session that cannot be reached (A36). The server never claims a session stopped unless the
 * connector says so.
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

// Links of earlier tests time out; each test dials its own connector and starts with no open
// session (one person holds one open session per notebook).
beforeEach(async () => {
  relay.advance(61_000);
  await testDb.db
    .update(notebookSessions)
    .set({ state: 'stopped', cause: 'abandoned', stoppedAt: relay.now() })
    .where(notInArray(notebookSessions.state, ['stopped', 'failed']));
});

const base = `/api/classes/${ids.classA}/notebook-sessions`;

async function row(sessionId: string) {
  const [found] = await testDb.db
    .select()
    .from(notebookSessions)
    .where(eq(notebookSessions.id, sessionId));
  return found;
}

const session = async (sessionId: string) =>
  (await call(relay, cookie, 'GET', `${base}/${sessionId}`)).body;

/** Opens a session on a new live connector and answers `open_session` with `answer`. */
async function opened(
  answer: (request: Received) => object | undefined,
  options: { runtime?: object } = {},
) {
  const live = await liveConnector(relay);
  const connectionId = await saveConnection(relay, cookie, live.id, options);
  return { ...live, connectionId, ...(await openOn(live.connector, connectionId, answer)) };
}

async function openOn(
  connector: FakeConnector,
  connectionId: string,
  answer: (request: Received) => object | undefined,
) {
  const res = await call(relay, cookie, 'POST', base, { connectionId, revisionId });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(res.body.state).toBe('starting');
  const request = await connector.next('open_session');
  const reply = answer(request);
  if (reply) connector.send(reply);
  return { sessionId: res.body.sessionId as string, request };
}

const ready =
  (owned = true) =>
  (request: Received) =>
    sessionState(relay, request.sessionId as string, 'ready', {
      requestId: request.requestId,
      owned,
    });

/** Polls until the session is in `state`. */
const reaches = (sessionId: string, state: string) =>
  relay.until(async () => (await row(sessionId))?.state === state, `the session to be ${state}`);

describe('A32 Disconnect and Stop', () => {
  test('open_session carries the target, the runtime and the lease, and ready is applied', async () => {
    const s = await opened(ready());
    expect(s.request).toMatchObject({
      sessionId: s.sessionId,
      target: { kind: 'ssh', host: 'login.cluster.example.org', user: 'student' },
      runtime: { mode: 'start', kernelName: 'python3' },
      lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
    });
    await reaches(s.sessionId, 'ready');
    expect(await session(s.sessionId)).toMatchObject({ state: 'ready', owned: true, cause: null });
  });

  test('A32 stop of an attached session is refused with not_owned', async () => {
    const s = await opened(ready(false), { runtime: { mode: 'attach', port: 8888 } });
    await reaches(s.sessionId, 'ready');
    const res = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true });
    expect(res).toMatchObject({ status: 409, body: { error: 'not_owned' } });
    await settled(relay, s.id);
    expect(s.connector.received.filter((m) => m.t === 'close_session')).toEqual([]);
    expect((await row(s.sessionId))?.state).toBe('ready');

    // The connector's own refusal of a stop it was sent anyway leaves the session as it was.
    await testDb.db
      .update(notebookSessions)
      .set({ owned: true })
      .where(eq(notebookSessions.id, s.sessionId));
    s.connector.answer('close_session', (m) => ({
      v: 1,
      t: 'error',
      requestId: m.requestId,
      sessionId: s.sessionId,
      code: 'not_owned',
    }));
    const sent = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true });
    expect(sent.status).toBe(202);
    await reaches(s.sessionId, 'ready');
  });

  test('A32 detach keeps the session ready', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    s.connector.answer('close_session', (m) =>
      sessionState(relay, s.sessionId, 'ready', { requestId: m.requestId, phase: 'detached' }),
    );
    const res = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: false });
    expect(res.status).toBe(202);
    expect(await s.connector.next('close_session')).toMatchObject({
      sessionId: s.sessionId,
      stop: false,
    });
    await settled(relay, s.id);
    expect(await session(s.sessionId)).toMatchObject({ state: 'ready', cause: null });
  });

  test('A32 stop is confirmed only when the connector says stopped', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    s.connector.answer('close_session', (m) =>
      sessionState(relay, s.sessionId, 'stopping', { requestId: m.requestId }),
    );
    const res = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true });
    expect(res).toMatchObject({ status: 202, body: { state: 'stopping' } });
    expect(await s.connector.next('close_session')).toMatchObject({ stop: true });
    await settled(relay, s.id);
    expect((await row(s.sessionId))?.state).toBe('stopping');

    s.connector.send(sessionState(relay, s.sessionId, 'stopped', { cause: 'user_stop' }));
    await reaches(s.sessionId, 'stopped');
    expect(await session(s.sessionId)).toMatchObject({ state: 'stopped', cause: 'user_stop' });
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'session.stopped'), eq(auditEvents.targetId, s.sessionId)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scopeKind: 'class', scopeId: ids.classA });
  });
});

describe('A36 lost sessions, refusals and Forget', () => {
  test("A36 a session stopped while the link was down gets the connector's cause, not connector_restarted", async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    s.connector.close();
    await reaches(s.sessionId, 'unconfirmed');
    expect(await session(s.sessionId)).toMatchObject({ state: 'unconfirmed', cause: 'link_lost' });

    const again = await relink(relay, s.id, s.key);
    again.heartbeat(0, [{ sessionId: s.sessionId, state: 'stopped', cause: 'sleep' }]);
    await reaches(s.sessionId, 'stopped');
    expect(await session(s.sessionId)).toMatchObject({ state: 'stopped', cause: 'sleep' });
  });

  test('A36 a session is not stopped or cleaned up before the first heartbeat after hello', async () => {
    // An owned session the server failed (the connector refused it) and one that went unconfirmed.
    const failed = await opened((request) => ({
      v: 1,
      t: 'error',
      requestId: request.requestId,
      sessionId: request.sessionId,
      code: 'limit_exceeded',
    }));
    await reaches(failed.sessionId, 'failed');
    const lost = await openOn(failed.connector, failed.connectionId, ready());
    await reaches(lost.sessionId, 'ready');
    failed.connector.close();
    await reaches(lost.sessionId, 'unconfirmed');

    const again = await relink(relay, failed.id, failed.key);
    // A late report that the failed session runs, before the first heartbeat.
    again.send(sessionState(relay, failed.sessionId, 'ready'));
    await settled(relay, failed.id);
    expect(again.received.filter((m) => m.t === 'close_session')).toEqual([]);
    expect((await row(lost.sessionId))?.state).toBe('unconfirmed');
    expect((await row(failed.sessionId))?.state).toBe('failed');

    // The first heartbeat lists only the failed session, still running.
    again.heartbeat(0, [{ sessionId: failed.sessionId, state: 'ready' }]);
    expect(await again.next('close_session')).toMatchObject({
      sessionId: failed.sessionId,
      stop: true,
    });
    await reaches(lost.sessionId, 'stopped');
    expect(await session(lost.sessionId)).toMatchObject({ cause: 'connector_restarted' });
    expect((await row(failed.sessionId))?.state).toBe('failed');
  });

  test('A36 an open_session refused with limit_exceeded fails with that code', async () => {
    const s = await opened((request) => ({
      v: 1,
      t: 'error',
      requestId: request.requestId,
      sessionId: request.sessionId,
      code: 'limit_exceeded',
    }));
    await reaches(s.sessionId, 'failed');
    expect(await session(s.sessionId)).toMatchObject({ state: 'failed', cause: 'limit_exceeded' });
    expect((await row(s.sessionId))?.stoppedAt).not.toBeNull();
  });

  test('A36 a failed stop returns to the last state and Forget works from stopping', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    s.connector.send(sessionState(relay, s.sessionId, 'disconnected', { cause: 'vpn' }));
    await reaches(s.sessionId, 'disconnected');

    // The connector refuses the stop: back to disconnected, with its cause.
    s.connector.answer('close_session', (m) => ({
      v: 1,
      t: 'error',
      requestId: m.requestId,
      sessionId: s.sessionId,
      code: 'internal',
    }));
    expect(
      (await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true })).body
        .state,
    ).toBe('stopping');
    await reaches(s.sessionId, 'disconnected');
    expect(await session(s.sessionId)).toMatchObject({ cause: 'vpn' });

    // The connector says nothing for 30 s: back to disconnected again.
    s.connector.answer('close_session', () => undefined);
    await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true });
    expect((await row(s.sessionId))?.state).toBe('stopping');
    await keepAlive(relay, s.connector, STOP_TIMEOUT_MS - 1);
    await settled(relay, s.id);
    expect((await row(s.sessionId))?.state).toBe('stopping');
    await keepAlive(relay, s.connector, 1);
    await reaches(s.sessionId, 'disconnected');

    // Stop once more, then Forget while it is stopping: nothing is sent.
    await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true });
    const closes = () => s.connector.received.filter((m) => m.t === 'close_session').length;
    await relay.until(() => closes() === 3, 'the third close_session');
    const sent = s.connector.received.length;
    const forgot = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/forget`);
    expect(forgot).toMatchObject({ status: 200, body: { state: 'stopped', cause: 'abandoned' } });
    await settled(relay, s.id);
    expect(s.connector.received.slice(sent).filter((m) => m.t !== 'heartbeat_ack')).toEqual([]);
  });

  test('A36 Forget frees a session that cannot be reached so a new one can start', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    // A ready session can be reached: Forget is refused.
    expect(await call(relay, cookie, 'POST', `${base}/${s.sessionId}/forget`)).toMatchObject({
      status: 409,
      body: { error: 'not_forgettable' },
    });
    s.connector.close();
    await reaches(s.sessionId, 'unconfirmed');

    const again = await relink(relay, s.id, s.key);
    const blocked = await call(relay, cookie, 'POST', base, {
      connectionId: s.connectionId,
      revisionId,
    });
    expect(blocked).toMatchObject({
      status: 409,
      body: { error: 'session_exists', sessionId: s.sessionId },
    });
    const forgot = await call(relay, cookie, 'POST', `${base}/${s.sessionId}/forget`);
    expect(forgot.body).toMatchObject({ state: 'stopped', cause: 'abandoned' });
    const next = await openOn(again, s.connectionId, ready());
    expect(next.sessionId).not.toBe(s.sessionId);
    await reaches(next.sessionId, 'ready');
  });
});

describe('deadlines and clean-up (§10.7)', () => {
  test('a session still starting after 300 s fails with test_timeout, and a late ready is stopped', async () => {
    const s = await opened((request) =>
      sessionState(relay, request.sessionId as string, 'starting', {
        requestId: request.requestId,
      }),
    );
    await keepAlive(relay, s.connector, START_TIMEOUT_MS - 1);
    await settled(relay, s.id);
    expect((await row(s.sessionId))?.state).toBe('starting');
    await keepAlive(relay, s.connector, 1);
    await reaches(s.sessionId, 'failed');
    expect(await session(s.sessionId)).toMatchObject({ cause: 'test_timeout' });

    s.connector.send(sessionState(relay, s.sessionId, 'ready'));
    expect(await s.connector.next('close_session')).toMatchObject({
      sessionId: s.sessionId,
      stop: true,
    });
    expect((await row(s.sessionId))?.state).toBe('failed');
  });

  test('a lost link marks open sessions unconfirmed, never stopped', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    relay.advance(45_000);
    await reaches(s.sessionId, 'unconfirmed');
    expect(await session(s.sessionId)).toMatchObject({ cause: 'link_lost', stoppedAt: null });
    expect(
      await call(relay, cookie, 'POST', `${base}/${s.sessionId}/close`, { stop: true }),
    ).toMatchObject({ status: 409, body: { error: 'connector_offline' } });
  });

  test('revoking the connector leaves its sessions unconfirmed with connector_revoked', async () => {
    const s = await opened(ready());
    await reaches(s.sessionId, 'ready');
    const res = await call(relay, cookie, 'POST', `/api/me/connectors/${s.id}/revoke`);
    expect(res.status).toBe(200);
    await s.connector.closed;
    await settled(relay, s.id);
    expect(await session(s.sessionId)).toMatchObject({
      state: 'unconfirmed',
      cause: 'connector_revoked',
    });
  });
});
