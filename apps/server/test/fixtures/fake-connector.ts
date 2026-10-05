import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import { LINK_SUBPROTOCOL } from '@parallax/contracts';
import type { Db } from '../../src/db/client';
import { connectors } from '../../src/db/schema';
import type { LinkTimers } from '../../src/relay/links';
import { fingerprintOf, linkMessage } from '../../src/relay/signing';

/**
 * A TypeScript connector for server tests (docs/design/connector.md §15): it speaks protocol v1
 * over a real WebSocket against a listening relay, with an Ed25519 key derived from a seed and
 * answers scripted by the test. It checks nothing the server sends beyond JSON parsing; tests
 * assert on what it received.
 */

/** DER prefix of an Ed25519 PKCS #8 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ConnectorKey {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
  fingerprint: string;
}

/** The Ed25519 key of a 32-byte seed (deterministic, like `vectors/signing.json`). */
export function keyFromSeed(seed: Buffer): ConnectorKey {
  if (seed.length !== 32) throw new Error('a seed is 32 bytes');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = Buffer.from(jwk.x as string, 'base64url');
  return { privateKey, publicKey, fingerprint: fingerprintOf(publicKey) };
}

/** A seed that differs per `n`, so every test connector has its own key. */
export const seedOf = (n: number) => Buffer.alloc(32, n);

/** Inserts a personal connector of `ownerUserId` for `key`, in the state a test needs. */
export async function insertConnector(
  db: Db,
  input: {
    ownerUserId: string;
    key: ConnectorKey;
    status?: 'pending' | 'active' | 'revoked';
    name?: string;
    now: Date;
  },
): Promise<string> {
  const { now, key } = input;
  const status = input.status ?? 'active';
  const [row] = await db
    .insert(connectors)
    .values({
      ownerUserId: input.ownerUserId,
      name: input.name ?? 'Test connector',
      mode: 'personal',
      status,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      os: 'linux',
      arch: 'amd64',
      version: '0.1.0',
      createdAt: now,
      ...(status === 'pending' && { approveBy: new Date(now.getTime() + 15 * 60_000) }),
      ...(status !== 'pending' && { approvedAt: now }),
      ...(status === 'revoked' && { revokedAt: now, revokedReason: 'user' as const }),
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error('connector insert returned no row');
  return row.id;
}

/** A message from the server, as parsed JSON. */
export type Received = { v: number; t: string; [key: string]: unknown };

export interface FakeConnectorOptions {
  /** `ws://127.0.0.1:<port>/api/connector/v1/link`. */
  url: string;
  connectorId: string;
  key: ConnectorKey;
  /** The origin the connector signs: the one it was paired with. */
  origin: string;
  /** The connector's clock, unix seconds; the test's fake clock. */
  now: () => number;
  /** Subprotocols offered; the link's by default. */
  protocols?: string[];
}

export const defaultHello = {
  v: 1,
  t: 'hello',
  version: '0.1.0',
  os: 'linux',
  arch: 'amd64',
  mode: 'personal',
  targets: ['local', 'ssh'],
  features: { tty: true, agent: true, wsl: false },
  networkScope: { cidrs: ['10.20.0.0/16'], hosts: [] },
} as const;

/** One connector link, driven by the test. */
export class FakeConnector {
  /** Every text message received, in order. */
  readonly received: Received[] = [];
  /** Every binary frame received, in order. */
  readonly frames: Buffer[] = [];
  /** Resolves with the close code and reason once the link closes. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: { match: (m: Received) => boolean; resolve: (m: Received) => void }[] = [];
  private frameWaiters: ((frame: Buffer) => void)[] = [];
  private readonly frameListeners: ((frame: Buffer) => void)[] = [];
  private readonly answers = new Map<string, (m: Received) => void>();
  private cursor = 0;
  closeEvent: { code: number; reason: string } | undefined;

  private constructor(
    readonly socket: WebSocket,
    readonly options: FakeConnectorOptions,
  ) {
    socket.binaryType = 'arraybuffer';
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        this.closeEvent = { code: event.code, reason: event.reason };
        resolve(this.closeEvent);
      });
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        const frame = Buffer.from(event.data as ArrayBuffer);
        this.frames.push(frame);
        for (const listener of this.frameListeners) listener(frame);
        for (const waiter of this.frameWaiters.splice(0)) waiter(frame);
        return;
      }
      const message = JSON.parse(event.data) as Received;
      this.received.push(message);
      this.answers.get(message.t)?.(message);
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        this.cursor = this.received.length;
        waiter.resolve(message);
      }
    });
  }

  /** Opens the WebSocket and waits for the upgrade; rejects when the server refuses it. */
  static open(options: FakeConnectorOptions): Promise<FakeConnector> {
    const socket = new WebSocket(options.url, options.protocols ?? [LINK_SUBPROTOCOL]);
    const connector = new FakeConnector(socket, options);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(connector), { once: true });
      socket.addEventListener('error', () => reject(new Error('upgrade refused')), {
        once: true,
      });
    });
  }

  /**
   * The next message of type `t` after the last one awaited (or any type without `t`),
   * including one that already arrived.
   */
  next(t?: string): Promise<Received> {
    const match = (m: Received) => t === undefined || m.t === t;
    const at = this.received.findIndex((m, i) => i >= this.cursor && match(m));
    if (at >= 0) {
      this.cursor = at + 1;
      return Promise.resolve(this.received[at] as Received);
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  /** The next binary frame, including one that already arrived and was not awaited. */
  nextFrame(): Promise<Buffer> {
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  /** Calls `listener` with every later binary frame. */
  onFrame(listener: (frame: Buffer) => void): void {
    this.frameListeners.push(listener);
  }

  /** Answers every later message of type `t` with `reply`. */
  answer(t: string, reply: (message: Received) => object | undefined): void {
    this.answers.set(t, (m) => {
      const out = reply(m);
      if (out) this.send(out);
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer): void {
    this.socket.send(data);
  }

  /** The `auth` answer to `challenge`, signed with this connector's key unless overridden. */
  authFor(
    challenge: Received,
    overrides: { ts?: number; origin?: string; key?: ConnectorKey; connectorId?: string } = {},
  ) {
    const connectorId = overrides.connectorId ?? this.options.connectorId;
    const ts = overrides.ts ?? this.options.now();
    const message = linkMessage(
      Buffer.from(challenge.nonce as string, 'base64url'),
      connectorId,
      ts,
      overrides.origin ?? this.options.origin,
    );
    const sig = sign(null, message, (overrides.key ?? this.options.key).privateKey);
    return { v: 1, t: 'auth', connectorId, ts, sig: sig.toString('base64url') };
  }

  /** Answers the challenge; resolves with `auth_ok`. */
  async authenticate(overrides: Parameters<FakeConnector['authFor']>[1] = {}) {
    const challenge = await this.next('challenge');
    this.send(this.authFor(challenge, overrides));
    return this.next('auth_ok');
  }

  /** Authenticates and says `hello`; the link is live once the server stored it. */
  async link(hello: Partial<Record<keyof typeof defaultHello, unknown>> = {}) {
    const ok = await this.authenticate();
    this.send({ ...defaultHello, ...hello });
    return ok;
  }

  heartbeat(seq: number, sessions: object[] = []) {
    this.send({ v: 1, t: 'heartbeat', seq, ts: this.options.now(), sessions });
  }

  close(code = 1000) {
    this.socket.close(code);
  }
}

/**
 * Timers that run only when the test advances them (ADR-0006 fake time), for the registry's
 * deadlines, heartbeat watchdog and re-reads.
 */
export class ManualTimers implements LinkTimers {
  private at = 0;
  private timers: { due: number; run: () => void }[] = [];

  after(ms: number, run: () => void): () => void {
    const timer = { due: this.at + ms, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Runs, in due order, every timer due within `ms`; timers they set run too when due. */
  advance(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.at = next.due;
      next.run();
    }
    this.at = until;
  }

  /** Timers still waiting. */
  get pending(): number {
    return this.timers.length;
  }
}
