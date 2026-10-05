import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encodeFrame, FLAG_END } from '../../src/relay/framing';
import {
  type Link,
  type LinkRequest,
  LinkRequestError,
  type LinkStream,
} from '../../src/relay/links';
import type { FakeConnector, Received } from '../fixtures/fake-connector';
import { createTestDatabase, type TestDatabase } from './db';
import { type Relay, startRelay } from './relay';

/**
 * Requests and streams of a live link (docs/design/connector.md §4.3, §4.5, §10.4): answers
 * matched by `requestId`, pending requests rejected when the link closes, stream ids allocated
 * up to `maxStreams`, credit-based flow control both ways, and messages naming no request or
 * stream of the link dropped and counted.
 */

const start = new Date('2026-10-01T09:00:00Z');
const sessionId = '7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
let testDb: TestDatabase;
let relay: Relay;

beforeAll(async () => {
  testDb = await createTestDatabase();
  relay = await startRelay(testDb, start);
});

afterAll(async () => {
  await relay?.close();
  await testDb?.drop();
});

beforeEach(() => relay.advance(61_000));

async function live(): Promise<{ link: Link; connector: FakeConnector }> {
  const { id, key } = await relay.connector();
  const connector = await relay.dial(id, key);
  await connector.link();
  await relay.until(() => relay.links.get(id) !== undefined, 'the link to go live');
  return { link: relay.links.get(id) as Link, connector };
}

const testConnection = (requestId = randomUUID()): LinkRequest => ({
  v: 1,
  t: 'test_connection',
  requestId,
  target: { kind: 'local', workspace: '/home/sam/parallax' },
  runtime: { mode: 'start', kernelName: 'python3' },
});

const httpOpen = (streamId: number) => ({
  v: 1 as const,
  t: 'http' as const,
  streamId,
  sessionId,
  purpose: 'session' as const,
  method: 'GET' as const,
  path: '/api/status',
  headers: {},
  body: 'none' as const,
});

const wsOpen = (streamId: number) => ({
  v: 1 as const,
  t: 'ws_open' as const,
  streamId,
  sessionId,
  path: '/api/kernels/9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f/channels',
});

describe('link requests', () => {
  test('progress and the final answer are matched by requestId', async () => {
    const { link, connector } = await live();
    connector.answer('test_connection', (m) => {
      const stage = { name: 'workspace', status: 'ok', ms: 3 };
      connector.send({ v: 1, t: 'test_progress', requestId: m.requestId, stage });
      return {
        v: 1,
        t: 'test_result',
        requestId: m.requestId,
        outcome: 'ready_to_start',
        stages: [stage],
      };
    });
    const progress: unknown[] = [];
    const request = testConnection();
    const answer = await link.request(request, {
      timeoutMs: 30_000,
      onProgress: (p) => progress.push(p.stage),
    });
    expect(answer).toMatchObject({ t: 'test_result', requestId: request.requestId });
    expect(progress).toEqual([{ name: 'workspace', status: 'ok', ms: 3 }]);
    expect(await connector.next('test_connection')).toEqual(request);
    connector.close();
  });

  test('an error naming the request is its answer', async () => {
    const { link, connector } = await live();
    connector.answer('open_session', (m) => ({
      v: 1,
      t: 'error',
      requestId: m.requestId,
      sessionId: m.sessionId,
      code: 'limit_exceeded',
    }));
    const answer = await link.request(
      {
        v: 1,
        t: 'open_session',
        requestId: randomUUID(),
        sessionId,
        target: { kind: 'local', workspace: '/home/sam/parallax' },
        runtime: { mode: 'start' },
        lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
      },
      { timeoutMs: 30_000 },
    );
    expect(answer).toMatchObject({ t: 'error', code: 'limit_exceeded' });
    connector.close();
  });

  test('a target breaking a rule of §4.4 is refused before anything is sent', async () => {
    const { link, connector } = await live();
    const request = {
      ...testConnection(),
      target: { kind: 'local' as const, workspace: '/home/sam/../root' },
    };
    await expect(link.request(request, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'invalid_target',
    });
    connector.heartbeat(0);
    await connector.next('heartbeat_ack');
    expect(connector.received.map((m) => m.t)).not.toContain('test_connection');
    connector.close();
  });

  test('a request without an answer in time is rejected with test_timeout', async () => {
    const { link, connector } = await live();
    const pending = link.request(testConnection(), { timeoutMs: 30_000 });
    await connector.next('test_connection');
    relay.advance(30_000);
    await expect(pending).rejects.toMatchObject({ code: 'test_timeout' });
    connector.close();
  });

  test('a closing link rejects every pending request with connector_offline', async () => {
    const { link, connector } = await live();
    const first = link.request(testConnection(), { timeoutMs: 30_000 });
    const second = link.request(testConnection(), { timeoutMs: 30_000 });
    await connector.next('test_connection');
    connector.close();
    await expect(first).rejects.toEqual(new LinkRequestError('connector_offline'));
    await expect(second).rejects.toMatchObject({ code: 'connector_offline' });
    await expect(link.request(testConnection(), { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'connector_offline',
    });
  });

  test('an answer to no pending request is dropped and counted', async () => {
    const { link, connector } = await live();
    const before = relay.links.unmatchedMessages;
    connector.send({
      v: 1,
      t: 'test_result',
      requestId: randomUUID(),
      outcome: 'failed',
      stages: [{ name: 'workspace', status: 'failed', code: 'workspace_missing' }],
    });
    connector.send({ v: 1, t: 'window', streamId: 99, credit: 10 });
    await relay.until(() => relay.links.unmatchedMessages === before + 2, 'the count');
    expect(relay.links.get(link.connectorId)).toBe(link);
    connector.close();
  });
});

describe('link streams', () => {
  test('stream ids count up from 1 and at most maxStreams are open at once', async () => {
    const { link, connector } = await live();
    const streams: LinkStream[] = [];
    for (let i = 0; i < 32; i++) streams.push(link.openStream(sessionId, httpOpen));
    expect(streams.map((s) => s.id)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(() => link.openStream(sessionId, httpOpen)).toThrow(
      new LinkRequestError('limit_exceeded', 'at most 32 streams'),
    );
    // A finished stream frees its slot; ids are never reused.
    connector.send({ v: 1, t: 'http_head', streamId: 5, status: 200, headers: {}, body: 'none' });
    await relay.until(() => {
      try {
        streams.push(link.openStream(sessionId, httpOpen));
        return true;
      } catch {
        return false;
      }
    }, 'a free stream slot');
    expect(streams.at(-1)?.id).toBe(33);
    connector.close();
  });

  test('a response body is delivered and its END frame finishes the stream', async () => {
    const { link, connector } = await live();
    const data: string[] = [];
    const controls: Received[] = [];
    let closed: unknown;
    const stream = link.openStream(sessionId, httpOpen, {
      onData: (payload, flags) => data.push(`${payload.toString()}${flags.end ? '|end' : ''}`),
      onControl: (m) => controls.push(m as unknown as Received),
      onClose: (reason) => {
        closed = reason;
      },
    });
    expect(await connector.next('http')).toMatchObject({
      streamId: stream.id,
      path: '/api/status',
    });
    connector.send({
      v: 1,
      t: 'http_head',
      streamId: stream.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'stream',
    });
    const payload = Buffer.from('{"started":"…"}');
    connector.sendRaw(encodeFrame({ streamId: stream.id, flags: 0, payload }, 65536));
    connector.sendRaw(
      encodeFrame({ streamId: stream.id, flags: FLAG_END, payload: Buffer.alloc(0) }, 65536),
    );
    await relay.until(() => closed !== undefined, 'the end of the body');
    expect(controls.map((m) => m.t)).toEqual(['http_head']);
    expect(data).toEqual(['{"started":"…"}', '|end']);
    expect(closed).toEqual({ code: 'done' });
    connector.close();
  });

  test('writes stop at the window and resume when the connector grants credit', async () => {
    const { link, connector } = await live();
    const stream = link.openStream(sessionId, wsOpen);
    await connector.next('ws_open');
    const body = Buffer.alloc(300 * 1024, 7);
    let written = false;
    const writing = stream.write(body, { end: true }).then(() => {
      written = true;
    });
    // 256 KiB of initial window: four 64 KiB frames, then the writer waits.
    await relay.until(() => connector.frames.length === 4, 'the first window');
    expect(connector.frames.map((f) => f.length - 5)).toEqual([65536, 65536, 65536, 65536]);
    expect(written).toBe(false);
    connector.send({ v: 1, t: 'window', streamId: stream.id, credit: 65536 });
    await writing;
    await relay.until(() => connector.frames.length === 5, 'the rest of the message');
    expect(connector.frames.map((f) => f.length - 5).slice(4)).toEqual([300 * 1024 - 262144]);
    expect(connector.frames.at(-1)?.readUInt8(4)).toBe(FLAG_END);
    connector.close();
  });

  test('data beyond the granted window resets the stream with limit_exceeded', async () => {
    const { link, connector } = await live();
    let closed: unknown;
    let received = 0;
    const stream = link.openStream(sessionId, wsOpen, {
      onData: (payload) => {
        received += payload.length;
      },
      onClose: (reason) => {
        closed = reason;
      },
    });
    await connector.next('ws_open');
    connector.send({ v: 1, t: 'ws_opened', streamId: stream.id });
    const chunk = Buffer.alloc(65536, 1);
    for (let i = 0; i < 4; i++) {
      connector.sendRaw(encodeFrame({ streamId: stream.id, flags: 0, payload: chunk }, 65536));
    }
    await relay.until(() => received === 262144, 'the window to fill');
    // The relay hands 64 KiB on and grants it back; the connector may send exactly that more.
    stream.grant(65536);
    expect(await connector.next('window')).toEqual({
      v: 1,
      t: 'window',
      streamId: stream.id,
      credit: 65536,
    });
    connector.sendRaw(encodeFrame({ streamId: stream.id, flags: 0, payload: chunk }, 65536));
    connector.sendRaw(
      encodeFrame({ streamId: stream.id, flags: 0, payload: Buffer.alloc(1) }, 65536),
    );
    expect(await connector.next('stream_reset')).toMatchObject({
      streamId: stream.id,
      code: 'limit_exceeded',
    });
    expect(closed).toEqual({ code: 'limit_exceeded' });
    expect(received).toBe(262144 + 65536);
    await expect(stream.write(Buffer.from('late'))).rejects.toBeInstanceOf(LinkRequestError);
    connector.close();
  });

  test('a stream reset or ws_close from the connector ends the stream', async () => {
    const { link, connector } = await live();
    const ends: unknown[] = [];
    const a = link.openStream(sessionId, wsOpen, { onClose: (r) => ends.push(['a', r]) });
    const b = link.openStream(sessionId, wsOpen, { onClose: (r) => ends.push(['b', r]) });
    connector.send({ v: 1, t: 'stream_reset', streamId: a.id, code: 'path_not_allowed' });
    connector.send({ v: 1, t: 'ws_close', streamId: b.id, code: 1000 });
    await relay.until(() => ends.length === 2, 'both ends');
    expect(ends).toEqual([
      ['a', { code: 'path_not_allowed' }],
      ['b', { code: 'done' }],
    ]);
    connector.close();
  });

  test('a closing link ends every open stream with connector_offline', async () => {
    const { link, connector } = await live();
    let closed: unknown;
    link.openStream(sessionId, wsOpen, {
      onClose: (reason) => {
        closed = reason;
      },
    });
    connector.close();
    await relay.until(() => closed !== undefined, 'the stream end');
    expect(closed).toEqual({ code: 'connector_offline' });
  });

  test('a frame for no open stream is dropped and counted; a malformed frame ends the link', async () => {
    const { link, connector } = await live();
    const before = relay.links.unmatchedMessages;
    connector.sendRaw(encodeFrame({ streamId: 77, flags: 0, payload: Buffer.from('x') }, 65536));
    await relay.until(() => relay.links.unmatchedMessages === before + 1, 'the count');
    expect(relay.links.get(link.connectorId)).toBe(link);
    connector.sendRaw(Buffer.from('0000000180', 'hex'));
    expect(await connector.closed).toEqual({ code: 4400, reason: 'protocol_error' });
  });
});
