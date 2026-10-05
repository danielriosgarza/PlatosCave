import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { cellExecutions, notebookSessions } from '../../src/db/schema';
import { decodeFrame, encodeFrame, FLAG_END, FLAG_TEXT } from '../../src/relay/framing';
import { kernelRelays } from '../../src/relay/kernel';
import type { FakeConnector, Received } from '../fixtures/fake-connector';
import { ids } from '../fixtures/world';
import type { TestDatabase } from './db';
import { call, liveConnector, saveConnection, sessionState, settled } from './notebook-sessions';
import type { Relay } from './relay';

/**
 * Helpers for the kernel and browser-channel tests (docs/design/connector.md §7, §10.5, §10.6):
 * a fake Jupyter answering the typed operations behind a fake connector, and a browser client
 * of the channel over a real WebSocket.
 */

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the messages freely.
type Json = Record<string, any>;

export const APP_ORIGIN = 'http://localhost:5173';
export const KERNEL = '9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f';

/** A kernel message as the fake Jupyter sends it. */
export function kernelMessage(
  msgType: string,
  parent: string | undefined,
  content: object,
  channel = 'iopub',
) {
  return {
    header: { msg_id: randomBytes(8).toString('hex'), msg_type: msgType, session: 'kernel' },
    parent_header: parent ? { msg_id: parent, msg_type: 'execute_request' } : {},
    metadata: {},
    content,
    channel,
  };
}

type KernelQuery = 'idle' | 'busy' | 404 | 'hold';

/**
 * Jupyter behind a fake connector: answers `http` requests for the kernel operations, opens the
 * kernel channel on `ws_open`, records every complete message the relay writes on it, and sends
 * kernel messages back on the current channel.
 */
export class FakeJupyter {
  /** Every `http` request, in order. */
  readonly http: Received[] = [];
  /** Every `ws_open`, in order. */
  readonly opened: Received[] = [];
  /** Every complete message the relay wrote on a kernel channel, parsed. */
  readonly written: { streamId: number; message: Json }[] = [];
  /** The answer to `GET /api/kernels/{id}`. */
  query: KernelQuery = 'idle';
  kernelId = KERNEL;
  /** Whether received frames are credited back (§4.5). */
  credit = true;
  channel: number | undefined;
  /** The workspace as Jupyter's contents API sees it: files by decoded path, and directories. */
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  /** Sizes reported for paths without sending their bytes (`content=0`), for limit tests. */
  readonly reportedSizes = new Map<string, number>();
  /** Every complete request body the relay sent on an `http` stream, by stream id. */
  readonly bodies = new Map<number, Buffer>();
  private partial = new Map<number, Buffer[]>();
  private held: Received[] = [];

  constructor(readonly connector: FakeConnector) {
    connector.answer('http', (m) => {
      this.http.push(m);
      if (m.body === 'stream') return undefined; // answered once the body arrived
      this.respond(m);
      return undefined;
    });
    connector.answer('ws_open', (m) => {
      this.opened.push(m);
      this.channel = m.streamId as number;
      return { v: 1, t: 'ws_opened', streamId: m.streamId };
    });
    connector.onFrame((bytes) => {
      const decoded = decodeFrame(bytes, 65536);
      if (!decoded.ok) throw new Error('bad frame from the relay');
      const { streamId, flags, payload } = decoded.frame;
      const parts = this.partial.get(streamId) ?? [];
      parts.push(payload);
      this.partial.set(streamId, parts);
      // Credit back what was received, as the real connector does once it handed data on.
      if (this.credit && payload.length > 0)
        connector.send({ v: 1, t: 'window', streamId, credit: payload.length });
      if (!(flags & FLAG_END)) return;
      this.partial.delete(streamId);
      const body = Buffer.concat(parts);
      const request = this.http.find((h) => h.streamId === streamId);
      if (request) {
        this.bodies.set(streamId, body);
        this.respond(request);
        return;
      }
      this.written.push({ streamId, message: JSON.parse(body.toString('utf8')) });
    });
  }

  /** The `execute_request`s written so far. */
  get executeRequests() {
    return this.written.filter((w) => w.message.header?.msg_type === 'execute_request');
  }

  /** The `contents` requests so far, with their decoded path, query and body. */
  get contentsRequests() {
    return this.http
      .filter((h) => h.purpose === 'contents')
      .map((h) => {
        const [raw = '', search = ''] = (h.path as string).split('?');
        const body = this.bodies.get(h.streamId as number);
        return {
          method: h.method as string,
          path: decodeURIComponent(raw.replace(/^\/api\/contents\/?/, '')),
          query: new URLSearchParams(search),
          body: body ? (JSON.parse(body.toString('utf8')) as Json) : undefined,
        };
      });
  }

  /** Jupyter's contents API over `files` and `dirs` (§7), as far as transfers use it. */
  private respondContents(m: Received): void {
    const streamId = m.streamId as number;
    const [raw = '', search = ''] = (m.path as string).split('?');
    const path = decodeURIComponent(raw.replace(/^\/api\/contents\/?/, ''));
    const query = new URLSearchParams(search);
    const name = path.split('/').pop() ?? '';
    const isDir = path === '' || this.dirs.has(path);
    if (m.method === 'GET') {
      if (isDir) {
        if (query.get('type') === 'file') {
          this.reply(streamId, 400, { message: `${path} is a directory, not a file` });
          return;
        }
        const prefix = path === '' ? '' : `${path}/`;
        const children = [...this.files.keys(), ...this.dirs]
          .filter(
            (p) => p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes('/'),
          )
          .map((p) => ({
            name: p.slice(prefix.length),
            path: p,
            type: this.dirs.has(p) ? 'directory' : 'file',
            size: this.dirs.has(p) ? null : (this.files.get(p)?.length ?? 0),
            last_modified: '2026-10-01T09:00:00Z',
          }));
        this.reply(streamId, 200, { name, path, type: 'directory', content: children });
        return;
      }
      const reported = this.reportedSizes.get(path);
      const bytes = this.files.get(path);
      if (bytes === undefined && reported === undefined) {
        this.reply(streamId, 404, { message: `No such file or directory: ${path}` });
        return;
      }
      const model = {
        name,
        path,
        type: 'file',
        size: reported ?? bytes?.length ?? 0,
        last_modified: '2026-10-01T09:00:00Z',
      };
      if (query.get('content') !== '1') {
        this.reply(streamId, 200, { ...model, content: null, format: null });
        return;
      }
      const format = query.get('format') === 'base64' ? 'base64' : 'text';
      const data = bytes ?? Buffer.alloc(reported ?? 0);
      this.reply(streamId, 200, {
        ...model,
        format,
        content: format === 'base64' ? data.toString('base64') : data.toString('utf8'),
      });
      return;
    }
    if (m.method === 'PUT') {
      const body = JSON.parse(this.bodies.get(streamId)?.toString('utf8') ?? '{}') as Json;
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent !== '' && !this.dirs.has(parent)) {
        this.reply(streamId, 404, { message: `No such directory: ${parent}` });
        return;
      }
      if (body.type === 'directory') {
        if (this.files.has(path)) {
          this.reply(streamId, 400, { message: 'a file is in the way' });
          return;
        }
        const existed = this.dirs.has(path);
        this.dirs.add(path);
        this.reply(streamId, existed ? 200 : 201, { name, path, type: 'directory' });
        return;
      }
      const content = String(body.content ?? '');
      const bytes =
        body.format === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      const existed = this.files.has(path);
      this.files.set(path, bytes);
      this.reply(streamId, existed ? 200 : 201, { name, path, type: 'file', size: bytes.length });
      return;
    }
    this.reply(streamId, 405, { message: 'not served' });
  }

  private respond(m: Received): void {
    const path = m.path as string;
    const method = m.method as string;
    const streamId = m.streamId as number;
    if (m.purpose === 'contents') {
      this.respondContents(m);
      return;
    }
    if (method === 'POST' && path === '/api/kernels') {
      this.reply(streamId, 201, {
        id: this.kernelId,
        name: 'python3',
        execution_state: 'idle',
      });
      return;
    }
    if (method === 'GET' && path === `/api/kernels/${this.kernelId}`) {
      if (this.query === 'hold') {
        this.held.push(m);
        return;
      }
      if (this.query === 404) {
        this.reply(streamId, 404, { message: 'Kernel does not exist' });
        return;
      }
      this.reply(streamId, 200, {
        id: this.kernelId,
        name: 'python3',
        execution_state: this.query,
      });
      return;
    }
    if (method === 'POST' && path.endsWith('/restart')) {
      this.reply(streamId, 200, {
        id: this.kernelId,
        name: 'python3',
        execution_state: 'restarting',
      });
      return;
    }
    if (method === 'POST' && path.endsWith('/interrupt')) {
      this.reply(streamId, 204);
      return;
    }
    if (method === 'DELETE') {
      this.reply(streamId, 204);
      return;
    }
    this.reply(streamId, 404, { message: 'not served' });
  }

  /** Answers the held kernel queries with `query`. */
  release(query: Exclude<KernelQuery, 'hold'>): void {
    this.query = query;
    for (const m of this.held.splice(0)) this.respond(m);
  }

  private reply(streamId: number, status: number, body?: object): void {
    if (body === undefined) {
      this.connector.send({ v: 1, t: 'http_head', streamId, status, headers: {}, body: 'none' });
      return;
    }
    this.connector.send({
      v: 1,
      t: 'http_head',
      streamId,
      status,
      headers: { 'content-type': 'application/json' },
      body: 'stream',
    });
    // Frames of at most 64 KiB, the last one carrying END (§4.5).
    const payload = Buffer.from(JSON.stringify(body));
    for (let at = 0; at < payload.length || at === 0; at += 65536) {
      const last = at + 65536 >= payload.length;
      this.connector.sendRaw(
        encodeFrame(
          { streamId, flags: last ? FLAG_END : 0, payload: payload.subarray(at, at + 65536) },
          65536,
        ),
      );
      if (last) break;
    }
  }

  /** Sends one kernel message on the current channel (or on `streamId`). */
  emit(message: object, streamId = this.channel): void {
    if (streamId === undefined) throw new Error('no kernel channel is open');
    this.connector.sendRaw(
      encodeFrame(
        { streamId, flags: FLAG_END | FLAG_TEXT, payload: Buffer.from(JSON.stringify(message)) },
        65536,
      ),
    );
  }

  /** Ends the current channel from the connector's side. */
  resetChannel(code = 'tunnel_unavailable'): void {
    this.connector.send({ v: 1, t: 'stream_reset', streamId: this.channel, code });
  }
}

/** A browser's channel to a notebook session. */
export class BrowserClient {
  readonly received: Json[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private cursor = 0;
  private waiters: { match: (m: Json) => boolean; resolve: (m: Json) => void }[] = [];

  private constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) =>
      socket.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      this.received.push(message);
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  static open(url: string, headers: Record<string, string>): Promise<BrowserClient> {
    const socket = new WebSocket(url, { headers } as never);
    const client = new BrowserClient(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(client), { once: true });
      socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
    });
  }

  /** The next message matching `match` (by type, or a predicate) after the last one awaited. */
  next(match: string | ((m: Json) => boolean)): Promise<Json> {
    const test = typeof match === 'string' ? (m: Json) => m.t === match : match;
    const at = this.received.findIndex((m, i) => i >= this.cursor && test(m));
    if (at >= 0) {
      this.cursor = at + 1;
      return Promise.resolve(this.received[at] as Json);
    }
    return new Promise((resolve, reject) => {
      // A hang names what was awaited and what did arrive, instead of a bare test timeout.
      const timer = setTimeout(() => {
        const seen = this.received
          .slice(this.cursor)
          .map((m) => `${m.t}:${m.state ?? m.code ?? ''}`);
        reject(new Error(`no ${String(match)} after [${seen.join(', ')}]`));
      }, 5000);
      this.waiters.push({
        match: test,
        resolve: (m) => {
          clearTimeout(timer);
          this.cursor = this.received.indexOf(m) + 1;
          resolve(m);
        },
      });
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close(1000);
  }
}

export const channelPath = (classId: string, sessionId: string) =>
  `/api/classes/${classId}/notebook-sessions/${sessionId}/channels`;

const baseUrl = (relay: Relay) => {
  const { port } = relay.app.server.address() as AddressInfo;
  return `127.0.0.1:${port}`;
};

/** Opens the browser channel of `sessionId` as the holder of `cookie`. */
export function openChannel(
  relay: Relay,
  cookie: string,
  sessionId: string,
  options: { origin?: string; classId?: string } = {},
): Promise<BrowserClient> {
  return BrowserClient.open(
    `ws://${baseUrl(relay)}${channelPath(options.classId ?? ids.classA, sessionId)}`,
    { cookie, origin: options.origin ?? APP_ORIGIN },
  );
}

/** The HTTP status a WebSocket upgrade of `path` gets: 101 when accepted, 0 on a hang-up. */
export function upgradeStatus(relay: Relay, path: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const [host, port] = baseUrl(relay).split(':');
    const req = request({
      host,
      port: Number(port),
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'ECONNRESET' ? resolve(0) : reject(err),
    );
    req.end();
  });
}

const base = (classId: string) => `/api/classes/${classId}/notebook-sessions`;

export interface ReadySession {
  connectorId: string;
  key: Awaited<ReturnType<typeof liveConnector>>['key'];
  connector: FakeConnector;
  jupyter: FakeJupyter;
  sessionId: string;
  url: string;
}

/**
 * A `ready` session of the holder of `cookie` (Sam by default) on a new live connector with a
 * fake Jupyter, and, unless `kernel: false`, a started kernel whose channel is open.
 */
export async function readySession(
  relay: Relay,
  testDb: TestDatabase,
  revisionId: string,
  options: {
    owner?: string;
    cookie?: string;
    classId?: string;
    kernel?: boolean;
    /** Passed to `saveConnection` (an attach runtime, another target). */
    connection?: Parameters<typeof saveConnection>[3];
    /** What the connector reports with `ready`. */
    report?: Record<string, unknown>;
  } = {},
): Promise<ReadySession> {
  const owner = options.owner ?? ids.sam;
  const cookie = options.cookie ?? relay.world.cookie.sam;
  const classId = options.classId ?? ids.classA;
  const live = await liveConnector(relay, owner);
  const jupyter = new FakeJupyter(live.connector);
  live.connector.answer('open_session', (m) =>
    sessionState(relay, m.sessionId as string, 'ready', {
      requestId: m.requestId,
      ...options.report,
    }),
  );
  const connectionId = await saveConnection(relay, cookie, live.id, options.connection);
  const res = await call(relay, cookie, 'POST', base(classId), { connectionId, revisionId });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const sessionId = res.body.sessionId as string;
  await relay.until(async () => {
    const [row] = await testDb.db
      .select({ state: notebookSessions.state })
      .from(notebookSessions)
      .where(eq(notebookSessions.id, sessionId));
    return row?.state === 'ready';
  }, 'the session to be ready');
  const url = `${base(classId)}/${sessionId}`;
  if (options.kernel !== false) {
    const started = await call(relay, cookie, 'POST', `${url}/kernel`, { kernelName: 'python3' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.kernel).toMatchObject({ id: KERNEL, name: 'python3', state: 'idle' });
  }
  return {
    connectorId: live.id,
    key: live.key,
    connector: live.connector,
    jupyter,
    sessionId,
    url,
  };
}

/** The execution rows of a session, in order. */
export const executionRows = (testDb: TestDatabase, sessionId: string) =>
  testDb.db
    .select()
    .from(cellExecutions)
    .where(eq(cellExecutions.sessionId, sessionId))
    .orderBy(cellExecutions.seq);

/** Waits until the relay applied everything queued for the session and its connector. */
export async function drained(relay: Relay, connectorId: string, sessionId: string) {
  await settled(relay, connectorId);
  await kernelRelays(relay.links)?.settled(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await kernelRelays(relay.links)?.settled(sessionId);
}

/** An `execute` of `code` with a fresh ref. */
export const execute = (code: string, ref: string = crypto.randomUUID(), cellId = 'cell-1') => ({
  v: 1,
  t: 'execute',
  ref,
  cellId,
  code,
});
