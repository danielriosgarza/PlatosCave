import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Link, LinkNotice } from '../../src/relay/links';
import { defaultHello, type FakeConnector } from '../fixtures/fake-connector';
import { createTestDatabase, type TestDatabase } from './db';
import { type Relay, startRelay } from './relay';

/**
 * Heartbeat and liveness of a live link (docs/design/connector.md §4.2, §4.1) on fake time:
 * every heartbeat is acknowledged at once, 45 s without one closes the link with 4408 and tells
 * the listeners, and messages are dispatched by type with unknown ones answered, not fatal.
 */

const start = new Date('2026-10-01T09:00:00Z');
let testDb: TestDatabase;
let relay: Relay;
const notices: LinkNotice[] = [];
const closes: { connectorId: string; code: number; reason: string }[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
  relay.links.on({
    notice: (_link: Link, message) => notices.push(message),
    close: (link, code, reason) => closes.push({ connectorId: link.connectorId, code, reason }),
  });
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

beforeEach(() => {
  relay.advance(61_000);
  notices.length = 0;
  closes.length = 0;
});

async function live(): Promise<{ id: string; connector: FakeConnector }> {
  const { id, key } = await relay.connector();
  const connector = await relay.dial(id, key);
  await connector.link();
  await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
  return { id, connector };
}

describe('link heartbeat', () => {
  test('every heartbeat is acknowledged at once with its seq and passed to listeners', async () => {
    const { id, connector } = await live();
    const session = { sessionId: '7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', state: 'ready' };
    connector.heartbeat(0, [session]);
    expect(await connector.next('heartbeat_ack')).toEqual({ v: 1, t: 'heartbeat_ack', seq: 0 });
    connector.heartbeat(1);
    expect(await connector.next('heartbeat_ack')).toEqual({ v: 1, t: 'heartbeat_ack', seq: 1 });
    expect(notices.map((n) => n.t)).toEqual(['heartbeat', 'heartbeat']);
    expect(notices[0]).toMatchObject({ seq: 0, sessions: [session] });
    expect(relay.links.get(id)).toBeDefined();
    connector.close();
  });

  test('the first heartbeat sent right behind hello is not lost', async () => {
    const { id, key } = await relay.connector();
    const connector = await relay.dial(id, key);
    await connector.authenticate();
    // §4.2: hello, then at once heartbeat seq 0 and the session states.
    connector.send(defaultHello);
    connector.heartbeat(0);
    expect(await connector.next('heartbeat_ack')).toMatchObject({ seq: 0 });
    expect(relay.links.get(id)).toBeDefined();
    connector.close();
  });

  test('45 s without a heartbeat closes the link with 4408 and tells the listeners', async () => {
    const { id, connector } = await live();
    relay.advance(44_999);
    expect(connector.closeEvent).toBeUndefined();
    relay.advance(1);
    expect(await connector.closed).toEqual({ code: 4408, reason: 'heartbeat_timeout' });
    expect(relay.links.get(id)).toBeUndefined();
    expect(closes).toEqual([{ connectorId: id, code: 4408, reason: 'heartbeat_timeout' }]);
  });

  test('heartbeats every 15 s keep the link alive past 45 s', async () => {
    const { id, connector } = await live();
    for (let seq = 0; seq < 6; seq++) {
      relay.advance(15_000);
      connector.heartbeat(seq);
      await connector.next('heartbeat_ack');
    }
    expect(connector.closeEvent).toBeUndefined();
    // The watchdog counts from the last heartbeat, not from the link's start.
    relay.advance(44_999);
    expect(connector.closeEvent).toBeUndefined();
    relay.advance(1);
    expect(await connector.closed).toEqual({ code: 4408, reason: 'heartbeat_timeout' });
    expect(relay.links.get(id)).toBeUndefined();
  });

  test('a connector closing its link tells the listeners', async () => {
    const { id, connector } = await live();
    connector.close(1000);
    await relay.until(() => closes.length === 1, 'the close');
    expect(closes).toEqual([{ connectorId: id, code: 1000, reason: '' }]);
  });

  test('a link refused before hello tells no listener', async () => {
    const { id, key } = await relay.connector({ status: 'pending' });
    const connector = await relay.dial(id, key);
    void connector.authenticate();
    expect(await connector.closed).toMatchObject({ code: 4403 });
    expect(closes).toEqual([]);
  });
});

describe('link message dispatch', () => {
  test('an unknown message type is answered unsupported_message and ignored', async () => {
    const { id, connector } = await live();
    connector.send({ v: 1, t: 'telemetry', cpu: 3 });
    expect(await connector.next('error')).toEqual({
      v: 1,
      t: 'error',
      code: 'unsupported_message',
      detail: 'telemetry',
    });
    connector.heartbeat(0);
    await connector.next('heartbeat_ack');
    expect(relay.links.get(id)).toBeDefined();
    connector.close();
  });

  test('a known message failing its schema ends the link with 4400', async () => {
    const { connector } = await live();
    connector.send({ v: 1, t: 'heartbeat', seq: -1, ts: 0, sessions: [] });
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a text frame that is not JSON ends the link with 4400', async () => {
    const { connector } = await live();
    connector.sendRaw('not json');
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a control message larger than maxControl ends the link with 4400', async () => {
    const { connector } = await live();
    // Over maxControl (65536) but within the socket's limit of maxPayload + 5 (65541, §4.1).
    const empty = JSON.stringify({ v: 1, t: 'error', code: 'internal', detail: '' });
    const detail = 'x'.repeat(65540 - empty.length);
    connector.sendRaw(JSON.stringify({ v: 1, t: 'error', code: 'internal', detail }));
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  test('a session state without a request reaches the listeners', async () => {
    const { connector } = await live();
    const state = {
      v: 1,
      t: 'session_state',
      sessionId: '7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      state: 'disconnected',
      owned: true,
      cause: 'sleep',
      ts: Math.floor(relay.now().getTime() / 1000),
    };
    connector.send(state);
    await relay.until(() => notices.length === 1, 'the notice');
    expect(notices[0]).toEqual(state);
    connector.close();
  });
});
