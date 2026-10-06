import {
  CONNECTOR_MESSAGE_TYPES,
  type ErrorCode,
  LINK_CLOSE,
  type LinkCloseReason,
  LinkConnectorMessage,
  type LinkLimits,
  LinkServerMessage,
  validateTarget,
} from '@parallax/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { z } from 'zod';
import type { Db } from '../db/client';
import {
  recordLinkHello,
  revokeUserConnectors as revokeUserConnectorRows,
  touchLinkConnector,
} from '../db/connectors/registry';
import { authenticateLink, Challenge, checkHello } from './auth';
import { CreditWindow, decodeFrame, encodeFrame, FLAG_END, FLAG_TEXT } from './framing';

/**
 * The live-link registry (docs/design/connector.md §4, §10.4): one authenticated WebSocket per
 * connector, held in this process (production runs one relay, §10.1). The registry runs each
 * link's handshake, keeps it alive (heartbeat watchdog, periodic re-read of the connector row),
 * matches answers to requests by `requestId`, allocates streams and accounts their credit.
 *
 * Only code holding a value returned by a scoped `db/` function names a connector here, so a
 * handler cannot message a connector it was not authorised for (§10.4).
 */

type ServerMessage = z.input<typeof LinkServerMessage>;
type ConnectorMessage = z.output<typeof LinkConnectorMessage>;
export type LinkHello = Extract<ConnectorMessage, { t: 'hello' }>;
export type LinkHeartbeat = Extract<ConnectorMessage, { t: 'heartbeat' }>;
/** Messages that ask the connector for something and are answered by `requestId`. */
export type LinkRequest = Extract<
  ServerMessage,
  { t: 'test_connection' | 'open_session' | 'close_session' }
>;
/** The final answer to a request: a test result, a session state or an error (§4.3). */
export type LinkAnswer = Extract<
  ConnectorMessage,
  { t: 'test_result' } | { t: 'session_state' } | { t: 'error' }
>;
export type LinkProgress = Extract<ConnectorMessage, { t: 'test_progress' }>;
/** What the connector sends about one stream. */
export type LinkStreamControl = Extract<
  ConnectorMessage,
  { t: 'http_head' } | { t: 'ws_opened' } | { t: 'ws_close' } | { t: 'stream_reset' }
>;
/** Messages no request or stream waits for: state notices, heartbeats, unmatched errors. */
export type LinkNotice = Extract<
  ConnectorMessage,
  { t: 'session_state' } | { t: 'heartbeat' } | { t: 'error' }
>;

/** The limits `auth_ok` announces (§4.5). */
export const DEFAULT_LIMITS: LinkLimits = {
  maxStreams: 32,
  maxPayload: 65536,
  initialWindow: 262144,
  maxControl: 65536,
  maxSessions: 4,
};
export const DEFAULT_HEARTBEAT_SECONDS = 15;
/** An unauthenticated socket is closed this long after the upgrade (§4.1). */
export const AUTH_DEADLINE_MS = 10_000;
/** How often a live link re-reads its connector row (§3 "Revoke and unpair"). */
export const RECHECK_MS = 60_000;
/** Link attempts allowed per address per minute (§10.3). */
export const LINK_ATTEMPTS_PER_MINUTE = 30;
/** Messages a connector may send before its `auth` or `hello` was checked. */
const MAX_HELD_MESSAGES = 128;
/** Heartbeats a live link may miss before it is dead: 3 × `heartbeatSeconds` (§4.2). */
const MISSED_HEARTBEATS = 3;

/** Why a request or stream failed: a catalogue code, or `connector_offline` for a lost link. */
export class LinkRequestError extends Error {
  constructor(
    readonly code: ErrorCode | 'connector_offline',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** One stream of a link (§4.5), opened by the server for one session. */
export interface LinkStream {
  readonly id: number;
  readonly sessionId: string;
  /** Sends `payload` as frames within the stream's credit, waiting for `window` as needed. */
  write(payload: Buffer, options?: { end?: boolean; text?: boolean }): Promise<void>;
  /** Grants the connector `bytes` more credit, after the data was handed on (§4.5). */
  grant(bytes: number): void;
  /** Aborts the stream with a catalogue code (`stream_reset`). */
  reset(code: ErrorCode, detail?: string): void;
  /** Closes a WebSocket stream (`ws_close`). */
  closeWebSocket(code: number, reason?: string): void;
}

export interface StreamHandlers {
  /** A frame from the connector; call `grant` once its payload has been handed on. */
  onData?: (payload: Buffer, flags: { end: boolean; text: boolean }) => void;
  onControl?: (message: LinkStreamControl) => void;
  /** The stream is over: finished, reset by either side, or its link closed. */
  onClose?: (reason: { code: ErrorCode | 'connector_offline' | 'done' }) => void;
}

/** One connector's live link. */
export interface Link {
  readonly connectorId: string;
  readonly limits: LinkLimits;
  /** What the connector reported when the link went live. */
  readonly hello: LinkHello;
  /** Sends a message that needs no answer (`presence`, `activity`). */
  send(message: Extract<ServerMessage, { t: 'presence' | 'activity' }>): void;
  /**
   * Sends a request and resolves with its final answer, matched by `requestId`. Rejects with
   * `connector_offline` when the link closes first, and with `test_timeout` after `timeoutMs`.
   * A target breaking a rule of §4.4 is refused with `invalid_target` before anything is sent.
   */
  request(
    message: LinkRequest,
    options: { timeoutMs: number; onProgress?: (progress: LinkProgress) => void },
  ): Promise<LinkAnswer>;
  /**
   * Allocates a stream id, sends the opening `http` or `ws_open` built for it, and returns the
   * stream. Throws `limit_exceeded` beyond `maxStreams`.
   */
  openStream(
    sessionId: string,
    open: (streamId: number) => Extract<ServerMessage, { t: 'http' | 'ws_open' }>,
    handlers?: StreamHandlers,
  ): LinkStream;
  /** Closes the link with a close code of §4.6 (4403 `revoked` after a revocation). */
  close(code: number, reason: string): void;
}

export interface LinkRegistry {
  /** The connector's live link, or nothing when it is offline. */
  get(connectorId: string): Link | undefined;
}

/** No connector holds a link: what the `api` mode uses, where no link route exists. */
export const emptyLinkRegistry: LinkRegistry = {
  get: () => undefined,
};

/** Timers the registry runs on; tests pass a manual clock (ADR-0006). */
export interface LinkTimers {
  after(ms: number, run: () => void): () => void;
}
/** Real timers, unref'd so they never hold the process open. */
export const systemTimers: LinkTimers = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export interface LinkRegistryOptions {
  db: Db;
  /** This server's origin, normalised: what connectors sign (§4.2). */
  origin: string;
  now: () => Date;
  log: FastifyBaseLogger;
  timers?: LinkTimers;
  heartbeatSeconds?: number;
  limits?: LinkLimits;
  /** Connectors below this version are refused with 4426 (§4.2). */
  minVersion?: string;
}

export interface LinkEvents {
  /** A link went live (after `hello`). */
  open?: (link: Link) => void;
  /** A live link closed, for any reason (§10.7 marks its sessions `unconfirmed`). */
  close?: (link: Link, code: number, reason: string) => void;
  /** A message no request or stream waited for. */
  notice?: (link: Link, message: LinkNotice) => void;
}

const reasonCode = (reason: LinkCloseReason) => LINK_CLOSE[reason];

/** The live registry of `relay` mode. */
export class LiveLinkRegistry implements LinkRegistry {
  private readonly links = new Map<string, LiveLink>();
  private readonly sockets = new Set<WebSocket>();
  private readonly attempts = new Map<string, number[]>();
  private readonly listeners: LinkEvents[] = [];
  readonly heartbeatSeconds: number;
  readonly limits: LinkLimits;
  readonly timers: LinkTimers;
  /** Connector messages naming a request or stream this link does not have (§10.4). */
  unmatchedMessages = 0;

  constructor(readonly options: LinkRegistryOptions) {
    this.heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.timers = options.timers ?? systemTimers;
  }

  get(connectorId: string): Link | undefined {
    return this.links.get(connectorId);
  }

  /** Subscribes to link events; returns the unsubscribe. */
  on(events: LinkEvents): () => void {
    this.listeners.push(events);
    return () => {
      const at = this.listeners.indexOf(events);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  emit<K extends keyof LinkEvents>(event: K, ...args: Parameters<NonNullable<LinkEvents[K]>>) {
    for (const listener of [...this.listeners]) {
      try {
        (listener[event] as ((...a: typeof args) => void) | undefined)?.(...args);
      } catch (err) {
        this.options.log.error({ err, event }, 'link listener failed');
      }
    }
  }

  /** The largest WebSocket message a link carries: `max(maxControl, maxPayload + 5)` (§4.1). */
  get maxMessageBytes(): number {
    return Math.max(this.limits.maxControl, this.limits.maxPayload + 5);
  }

  /** Takes one of `address`'s 30 link attempts a minute. */
  private takeAttempt(address: string, now: Date): boolean {
    const at = now.getTime();
    const recent = (this.attempts.get(address) ?? []).filter((t) => t > at - 60_000);
    if (recent.length >= LINK_ATTEMPTS_PER_MINUTE) return false;
    recent.push(at);
    this.attempts.delete(address);
    this.attempts.set(address, recent);
    if (this.attempts.size > 10_000) {
      this.attempts.delete(this.attempts.keys().next().value as string);
    }
    return true;
  }

  /** Runs one upgraded socket from the challenge to its close. */
  accept(socket: WebSocket, address: string): void {
    if (!this.takeAttempt(address, this.options.now())) {
      socket.close(reasonCode('rate_limited'), 'rate_limited');
      return;
    }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    new Handshake(this, socket).start();
  }

  /** Makes `link` the connector's live link; an older one is closed with 4409 `replaced`. */
  register(link: LiveLink): void {
    const older = this.links.get(link.connectorId);
    this.links.set(link.connectorId, link);
    older?.close(reasonCode('replaced'), 'replaced');
    this.emit('open', link);
  }

  /** Forgets a closed link unless a newer one already replaced it. */
  unregister(link: LiveLink): void {
    if (this.links.get(link.connectorId) === link) this.links.delete(link.connectorId);
  }

  /** Closes every socket (server shutdown: 1001, so connectors redial). */
  closeAll(): void {
    for (const link of [...this.links.values()]) link.close(1001, 'server shutting down');
    for (const socket of this.sockets) socket.close(1001, 'server shutting down');
  }

  unmatched(link: { connectorId: string }, message: { t: string }): void {
    this.unmatchedMessages++;
    this.options.log.warn(
      {
        connectorId: link.connectorId,
        t: message.t,
        relay_unmatched_messages: this.unmatchedMessages,
      },
      'connector message names no request or stream of its link',
    );
  }
}

/** Parses one text frame: the message, an unknown `t`, or a protocol error. */
function parseText(
  data: Buffer,
  maxControl: number,
):
  | { kind: 'message'; message: ConnectorMessage }
  | { kind: 'unknown'; t: string }
  | { kind: 'invalid' } {
  if (data.length > maxControl) return { kind: 'invalid' };
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { kind: 'invalid' };
  const t = (json as { t?: unknown }).t;
  if (typeof t !== 'string') return { kind: 'invalid' };
  if (!CONNECTOR_MESSAGE_TYPES.has(t)) return { kind: 'unknown', t };
  const parsed = LinkConnectorMessage.safeParse(json);
  return parsed.success ? { kind: 'message', message: parsed.data } : { kind: 'invalid' };
}

const asBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);

/** Sends one server message, checked against the schema; a failure is a bug here. */
function sendMessage(socket: WebSocket, message: ServerMessage, maxControl: number): void {
  const parsed = LinkServerMessage.parse(message);
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text) > maxControl) throw new Error(`${parsed.t} exceeds maxControl`);
  socket.send(text);
}

/** One socket from the challenge until it goes live as a `LiveLink` or is refused. */
class Handshake {
  private readonly challenge: Challenge;
  private state: 'challenged' | 'checking' | 'authenticated' | 'done' = 'challenged';
  private cancelDeadline: () => void = () => {};

  constructor(
    private readonly registry: LiveLinkRegistry,
    private readonly socket: WebSocket,
  ) {
    this.challenge = new Challenge(registry.options.now());
  }

  start(): void {
    const { options, limits, timers } = this.registry;
    this.socket.on('message', this.onMessage);
    this.socket.once('close', () => this.finish());
    this.cancelDeadline = timers.after(AUTH_DEADLINE_MS, () =>
      this.refuse('protocol_error', 'not authenticated in time'),
    );
    sendMessage(
      this.socket,
      {
        v: 1,
        t: 'challenge',
        nonce: this.challenge.nonce.toString('base64url'),
        origin: options.origin,
        ts: Math.floor(this.challenge.issuedAt.getTime() / 1000),
      },
      limits.maxControl,
    );
  }

  private finish(): void {
    this.state = 'done';
    this.cancelDeadline();
    this.socket.off('message', this.onMessage);
  }

  private refuse(reason: LinkCloseReason, why: string): void {
    if (this.state === 'done') return;
    this.registry.options.log.info({ reason, why }, 'connector link refused');
    this.finish();
    this.socket.close(reasonCode(reason), reason);
  }

  private connector: { id: string; mode: 'personal' | 'managed' } | undefined;

  /** Messages that arrived while `auth` or `hello` was being checked, in order. */
  private held: [RawData, boolean][] = [];

  /** Replays what arrived during a check, once its outcome is known. */
  private release(): [RawData, boolean][] {
    const held = this.held;
    this.held = [];
    return held;
  }

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    if (this.state === 'done') return;
    if (this.state === 'checking') {
      // `hello` is followed at once by the first heartbeat and session states (§4.2); they wait
      // for the check of what came before them.
      if (this.held.length >= MAX_HELD_MESSAGES) {
        this.refuse('protocol_error', 'too many early messages');
      } else {
        this.held.push([data, isBinary]);
      }
      return;
    }
    const parsed = isBinary
      ? undefined
      : parseText(asBuffer(data), this.registry.limits.maxControl);
    if (parsed?.kind !== 'message') {
      this.refuse('protocol_error', 'not a valid control message');
      return;
    }
    const message = parsed.message;
    if (this.state === 'challenged' && message.t === 'auth') {
      this.state = 'checking';
      void this.authenticate(message).catch((err) => {
        this.registry.options.log.error({ err }, 'connector link authentication failed');
        this.refuse('server_error', 'authentication failed');
      });
      return;
    }
    if (this.state === 'authenticated' && message.t === 'hello') {
      this.state = 'checking';
      void this.goLive(message).catch((err) => {
        this.registry.options.log.error({ err }, 'connector link hello failed');
        this.refuse('server_error', 'hello failed');
      });
      return;
    }
    this.refuse('protocol_error', `unexpected ${message.t}`);
  };

  private async authenticate(auth: Extract<ConnectorMessage, { t: 'auth' }>): Promise<void> {
    const { options, limits, heartbeatSeconds } = this.registry;
    const result = await authenticateLink(
      options.db,
      this.challenge,
      auth,
      options.origin,
      options.now(),
    );
    if (this.state !== 'checking') return;
    if (!result.ok) return this.refuse(result.reason, 'auth refused');
    this.connector = { id: result.connector.id, mode: result.connector.mode };
    this.state = 'authenticated';
    const held = this.release();
    sendMessage(
      this.socket,
      {
        v: 1,
        t: 'auth_ok',
        heartbeatSeconds,
        limits,
        ...(options.minVersion && { minVersion: options.minVersion }),
      },
      limits.maxControl,
    );
    for (const [data, isBinary] of held) this.onMessage(data, isBinary);
  }

  private async goLive(hello: LinkHello): Promise<void> {
    const { options } = this.registry;
    const connector = this.connector;
    if (!connector) return this.refuse('protocol_error', 'hello before auth');
    const refused = checkHello(connector, hello, options.minVersion);
    if (refused) return this.refuse(refused, 'hello refused');
    const { os, arch, version, networkScope } = hello;
    const active = await recordLinkHello(
      options.db,
      connector.id,
      { os, arch, version, networkScope },
      options.now(),
    );
    if (this.state !== 'checking') return;
    if (!active) return this.refuse('revoked', 'revoked before hello');
    const held = this.release();
    this.finish();
    const link = new LiveLink(this.registry, this.socket, connector.id, hello);
    this.registry.register(link);
    link.start(held);
  }
}

interface PendingRequest {
  resolve: (answer: LinkAnswer) => void;
  reject: (err: LinkRequestError) => void;
  onProgress?: (progress: LinkProgress) => void;
  cancelTimer: () => void;
}

class LiveLink implements Link {
  readonly limits: LinkLimits;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly streams = new Map<number, LiveStream>();
  private nextStreamId = 1;
  private closed = false;
  private cancelWatchdog: () => void = () => {};
  private cancelRecheck: () => void = () => {};

  constructor(
    private readonly registry: LiveLinkRegistry,
    private readonly socket: WebSocket,
    readonly connectorId: string,
    readonly hello: LinkHello,
  ) {
    this.limits = registry.limits;
  }

  /** Starts serving the socket, first handling what arrived while `hello` was checked. */
  start(held: [RawData, boolean][]): void {
    this.socket.on('message', this.onMessage);
    this.socket.once('close', (code: number, reason: Buffer) =>
      this.closed ? undefined : this.onClosed(code, reason.toString('utf8')),
    );
    this.armWatchdog();
    this.armRecheck();
    for (const [data, isBinary] of held) {
      if (!this.closed) this.onMessage(data, isBinary);
    }
  }

  private get log() {
    return this.registry.options.log;
  }

  /** 3 × `heartbeatSeconds` without a heartbeat: the link is dead (4408, §4.2). */
  private armWatchdog(): void {
    this.cancelWatchdog();
    const ms = MISSED_HEARTBEATS * this.registry.heartbeatSeconds * 1000;
    this.cancelWatchdog = this.registry.timers.after(ms, () =>
      this.close(reasonCode('heartbeat_timeout'), 'heartbeat_timeout'),
    );
  }

  /** Every 60 s: a connector no longer active loses its link even if the notice was lost. */
  private armRecheck(): void {
    this.cancelRecheck = this.registry.timers.after(RECHECK_MS, () => {
      const { db, now } = this.registry.options;
      touchLinkConnector(db, this.connectorId, now()).then(
        (active) => {
          if (this.closed) return;
          if (active) this.armRecheck();
          else this.close(reasonCode('revoked'), 'revoked');
        },
        (err) => {
          this.log.error({ err, connectorId: this.connectorId }, 'connector re-read failed');
          if (!this.closed) this.armRecheck();
        },
      );
    });
  }

  private sendRaw(message: ServerMessage): void {
    if (this.closed) throw new LinkRequestError('connector_offline');
    sendMessage(this.socket, message, this.limits.maxControl);
  }

  send(message: Extract<ServerMessage, { t: 'presence' | 'activity' }>): void {
    this.sendRaw(message);
  }

  request(
    message: LinkRequest,
    options: { timeoutMs: number; onProgress?: (progress: LinkProgress) => void },
  ): Promise<LinkAnswer> {
    if (this.closed) return Promise.reject(new LinkRequestError('connector_offline'));
    if (message.t !== 'close_session') {
      const parsed = LinkServerMessage.parse(message);
      if (parsed.t !== 'test_connection' && parsed.t !== 'open_session') throw new Error(parsed.t);
      const issues = validateTarget(parsed);
      if (issues.length > 0) {
        const rules = issues.map((i) => i.rule).join(', ');
        return Promise.reject(new LinkRequestError('invalid_target', `rules ${rules}`));
      }
    }
    if (this.requests.has(message.requestId)) {
      return Promise.reject(new Error(`request ${message.requestId} is already pending`));
    }
    return new Promise<LinkAnswer>((resolve, reject) => {
      const cancelTimer = this.registry.timers.after(options.timeoutMs, () => {
        this.requests.delete(message.requestId);
        reject(new LinkRequestError('test_timeout'));
      });
      this.requests.set(message.requestId, {
        resolve,
        reject,
        cancelTimer,
        ...(options.onProgress && { onProgress: options.onProgress }),
      });
      try {
        this.sendRaw(message);
      } catch (err) {
        cancelTimer();
        this.requests.delete(message.requestId);
        reject(err);
      }
    });
  }

  openStream(
    sessionId: string,
    open: (streamId: number) => Extract<ServerMessage, { t: 'http' | 'ws_open' }>,
    handlers: StreamHandlers = {},
  ): LinkStream {
    if (this.closed) throw new LinkRequestError('connector_offline');
    if (this.streams.size >= this.limits.maxStreams) {
      throw new LinkRequestError('limit_exceeded', `at most ${this.limits.maxStreams} streams`);
    }
    if (this.nextStreamId > 0xffffffff) throw new LinkRequestError('limit_exceeded', 'stream ids');
    const id = this.nextStreamId++;
    const message = open(id);
    if (message.streamId !== id || message.sessionId !== sessionId) {
      throw new Error('the opening message names another stream or session');
    }
    const stream = new LiveStream(
      this,
      id,
      sessionId,
      message.t === 'http' ? 'http' : 'ws',
      handlers,
    );
    this.streams.set(id, stream);
    try {
      this.sendRaw(message);
    } catch (err) {
      this.streams.delete(id);
      throw err;
    }
    return stream;
  }

  /** Sends a stream's frame or control message; false once the link is closed. */
  streamSend(data: Buffer | ServerMessage): boolean {
    if (this.closed) return false;
    if (Buffer.isBuffer(data)) this.socket.send(data);
    else this.sendRaw(data);
    return true;
  }

  forgetStream(id: number): void {
    this.streams.delete(id);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.onClosed(code, reason);
    this.socket.close(code, reason);
  }

  /** Everything a closed link owes: requests rejected, streams ended, listeners told. */
  private onClosed(code: number, reason: string): void {
    this.closed = true;
    this.cancelWatchdog();
    this.cancelRecheck();
    this.socket.off('message', this.onMessage);
    for (const pending of this.requests.values()) {
      pending.cancelTimer();
      pending.reject(new LinkRequestError('connector_offline'));
    }
    this.requests.clear();
    for (const stream of [...this.streams.values()]) stream.end('connector_offline');
    this.registry.unregister(this);
    this.log.info({ connectorId: this.connectorId, code, reason }, 'connector link closed');
    this.registry.emit('close', this, code, reason);
  }

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    const bytes = asBuffer(data);
    if (isBinary) {
      this.onFrame(bytes);
      return;
    }
    const parsed = parseText(bytes, this.limits.maxControl);
    if (parsed.kind === 'invalid') {
      this.close(reasonCode('protocol_error'), 'protocol_error');
      return;
    }
    if (parsed.kind === 'unknown') {
      this.sendRaw({
        v: 1,
        t: 'error',
        code: 'unsupported_message',
        detail: parsed.t.slice(0, 64),
      });
      return;
    }
    this.dispatch(parsed.message);
  };

  private onFrame(bytes: Buffer): void {
    const decoded = decodeFrame(bytes, this.limits.maxPayload);
    if (!decoded.ok) {
      this.close(reasonCode('protocol_error'), 'protocol_error');
      return;
    }
    const stream = this.streams.get(decoded.frame.streamId);
    if (!stream) {
      this.registry.unmatched(this, { t: 'frame' });
      return;
    }
    stream.receive(decoded.frame.payload, decoded.frame.flags);
  }

  private dispatch(message: ConnectorMessage): void {
    switch (message.t) {
      case 'auth':
      case 'hello':
        this.close(reasonCode('protocol_error'), 'protocol_error');
        return;
      case 'heartbeat':
        this.armWatchdog();
        this.sendRaw({ v: 1, t: 'heartbeat_ack', seq: message.seq });
        this.registry.emit('notice', this, message);
        return;
      case 'test_progress': {
        const pending = this.requests.get(message.requestId);
        if (!pending) {
          this.registry.unmatched(this, message);
          return;
        }
        pending.onProgress?.(message);
        return;
      }
      case 'test_result':
      case 'session_state':
      case 'error': {
        const pending =
          message.t === 'error' && message.streamId !== undefined && message.requestId === undefined
            ? undefined
            : message.requestId !== undefined
              ? this.requests.get(message.requestId)
              : undefined;
        if (pending) {
          this.requests.delete((message as { requestId: string }).requestId);
          pending.cancelTimer();
          pending.resolve(message);
          return;
        }
        if (message.t === 'test_result') {
          this.registry.unmatched(this, message);
          return;
        }
        if (message.t === 'error' && message.streamId !== undefined) {
          const stream = this.streams.get(message.streamId);
          if (!stream) {
            this.registry.unmatched(this, message);
            return;
          }
          stream.end(message.code as ErrorCode);
          return;
        }
        this.registry.emit('notice', this, message);
        return;
      }
      case 'window':
      case 'http_head':
      case 'ws_opened':
      case 'ws_close':
      case 'stream_reset': {
        const stream = this.streams.get(message.streamId);
        if (!stream) {
          this.registry.unmatched(this, message);
          return;
        }
        stream.control(message);
        return;
      }
    }
  }
}

class LiveStream implements LinkStream {
  private readonly sendWindow: CreditWindow;
  private readonly receiveWindow: CreditWindow;
  private readonly queue: {
    payload: Buffer;
    flags: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];
  private headBody: 'none' | 'stream' | undefined;
  private ended = false;

  constructor(
    private readonly link: LiveLink,
    readonly id: number,
    readonly sessionId: string,
    private readonly kind: 'http' | 'ws',
    private readonly handlers: StreamHandlers,
  ) {
    this.sendWindow = new CreditWindow(link.limits.initialWindow);
    this.receiveWindow = new CreditWindow(link.limits.initialWindow);
  }

  write(payload: Buffer, options: { end?: boolean; text?: boolean } = {}): Promise<void> {
    if (this.ended) return Promise.reject(new LinkRequestError('stream_cancelled'));
    const { maxPayload } = this.link.limits;
    const text = options.text ? FLAG_TEXT : 0;
    const chunks: Buffer[] = [];
    for (let at = 0; at < payload.length; at += maxPayload) {
      chunks.push(payload.subarray(at, at + maxPayload));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    const writes = chunks.map((chunk, i) => {
      const last = i === chunks.length - 1;
      const flags = text | (last && options.end ? FLAG_END : 0);
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ payload: chunk, flags, resolve, reject });
      });
    });
    this.flush();
    return Promise.all(writes).then(() => undefined);
  }

  /** Sends queued frames while the connector's credit lasts. */
  private flush(): void {
    while (!this.ended && this.queue.length > 0) {
      const next = this.queue[0];
      if (!next || !this.sendWindow.consume(next.payload.length)) return;
      this.queue.shift();
      const frame = encodeFrame(
        { streamId: this.id, flags: next.flags, payload: next.payload },
        this.link.limits.maxPayload,
      );
      if (this.link.streamSend(frame)) next.resolve();
      else next.reject(new LinkRequestError('connector_offline'));
    }
  }

  grant(bytes: number): void {
    if (this.ended || bytes < 1) return;
    if (!this.receiveWindow.grant(bytes)) {
      this.reset('limit_exceeded', 'window overflow');
      return;
    }
    this.link.streamSend({ v: 1, t: 'window', streamId: this.id, credit: bytes });
  }

  reset(code: ErrorCode, detail?: string): void {
    if (this.ended) return;
    this.link.streamSend({
      v: 1,
      t: 'stream_reset',
      streamId: this.id,
      code,
      ...(detail && { detail }),
    });
    this.end(code);
  }

  closeWebSocket(code: number, reason?: string): void {
    if (this.ended || this.kind !== 'ws') return;
    this.link.streamSend({
      v: 1,
      t: 'ws_close',
      streamId: this.id,
      code,
      ...(reason && { reason }),
    });
    this.end('done');
  }

  /** A frame from the connector, within the credit granted (§4.5). */
  receive(payload: Buffer, flags: number): void {
    if (this.ended) return;
    if (!this.receiveWindow.consume(payload.length)) {
      this.reset('limit_exceeded', 'sent beyond the window');
      return;
    }
    const end = (flags & FLAG_END) !== 0;
    this.handlers.onData?.(payload, { end, text: (flags & FLAG_TEXT) !== 0 });
    if (this.kind === 'http' && end && this.headBody === 'stream') this.end('done');
  }

  control(message: Extract<ConnectorMessage, { t: 'window' }> | LinkStreamControl): void {
    if (this.ended) return;
    if (message.t === 'window') {
      if (!this.sendWindow.grant(message.credit)) {
        this.reset('limit_exceeded', 'window overflow');
        return;
      }
      this.flush();
      return;
    }
    this.handlers.onControl?.(message);
    if (message.t === 'stream_reset') {
      this.end(message.code as ErrorCode);
      return;
    }
    if (message.t === 'ws_close') {
      this.end('done');
      return;
    }
    if (message.t === 'http_head') {
      this.headBody = message.body;
      if (message.body === 'none') this.end('done');
    }
  }

  /** Ends the stream locally: pending writes fail, the slot is freed, the handler is told. */
  end(code: ErrorCode | 'connector_offline' | 'done'): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.queue.splice(0)) {
      pending.reject(new LinkRequestError(code === 'done' ? 'stream_cancelled' : code));
    }
    this.link.forgetStream(this.id);
    this.handlers.onClose?.({ code });
  }
}

/**
 * Revokes every pending and active connector of one person (account deactivation, P4-09) and
 * closes their live links with 4403 `revoked` (§3).
 */
export async function revokeUserConnectors(
  db: Db,
  links: LinkRegistry,
  userId: string,
  now: Date,
): Promise<string[]> {
  const ids = await revokeUserConnectorRows(db, userId, now);
  closeRevokedLinks(links, ids);
  return ids;
}

/** Closes the live links of connectors already revoked in the database, with 4403 `revoked`. */
export function closeRevokedLinks(links: LinkRegistry, ids: string[]): void {
  for (const id of ids) links.get(id)?.close(reasonCode('revoked'), 'revoked');
}
