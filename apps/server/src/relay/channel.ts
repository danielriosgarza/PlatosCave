import {
  CHANNEL_CLIENT_TYPES,
  CHANNEL_CLOSE,
  ChannelClientMessage,
  ChannelServerMessage,
  type ChannelServerMessageInput,
} from '@parallax/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { OwnedSession } from '../db/notebooks/sessions';
import type { ChannelPeer, KernelRelay } from './kernel';
import type { LinkTimers } from './links';

/**
 * One browser's channel to one notebook session (docs/design/connector.md §10.5). The route has
 * already resolved the class scope, found the caller's own session and checked `Origin` before
 * the upgrade. Here the scope and the session are re-validated every 60 s and before every
 * message that names a resource (`execute`, `input_reply`, `interrupt`); losing either (a
 * revoked sign-in, a removed membership, a session no longer the caller's) closes the socket
 * with 4403 (ADR-0002 "Jobs and sockets"). Messages are handled one at a time, in order.
 */

/** §10.1: a resolved class scope is re-validated this often. */
export const REVALIDATE_MS = 60_000;
/** Messages a browser may send per second, whatever they are; more are refused `rate_limited`. */
export const MESSAGES_PER_SECOND = 60;

export interface ChannelContext {
  kernels: KernelRelay;
  /** Resolves the caller's scope again and reads the session through it; null once lost. */
  revalidate: () => Promise<OwnedSession | null>;
  timers: LinkTimers;
  now: () => Date;
  log: FastifyBaseLogger;
}

export class BrowserChannel implements ChannelPeer {
  private session: OwnedSession;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private cancelRevalidate: () => void = () => {};
  private recent: number[] = [];
  private attached: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: WebSocket,
    session: OwnedSession,
    private readonly context: ChannelContext,
  ) {
    this.session = session;
  }

  start(): void {
    this.socket.on('message', this.onMessage);
    this.socket.once('close', () => this.onClosed());
    this.attached = this.context.kernels.attach(this.session, this);
    this.armRevalidate();
  }

  send(message: ChannelServerMessageInput): void {
    if (this.closed) return;
    const parsed = ChannelServerMessage.parse(message);
    this.socket.send(JSON.stringify(parsed));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.onClosed();
    this.socket.close(code, reason);
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelRevalidate();
    this.socket.off('message', this.onMessage);
    void this.attached.then(() => this.context.kernels.detach(this.session, this));
  }

  private armRevalidate(): void {
    this.cancelRevalidate = this.context.timers.after(REVALIDATE_MS, () => {
      this.enqueue(async () => {
        if (await this.revalidate()) this.armRevalidate();
      });
    });
  }

  /** True while the caller still holds the scope and the session; closes the socket otherwise. */
  private async revalidate(): Promise<boolean> {
    if (this.closed) return false;
    let session: OwnedSession | null;
    try {
      session = await this.context.revalidate();
    } catch (err) {
      this.context.log.error({ err }, 'channel re-validation failed');
      session = null;
    }
    if (this.closed) return false;
    if (!session) {
      this.close(CHANNEL_CLOSE.scope_lost, 'scope_lost');
      return false;
    }
    this.session = session;
    return true;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((err) => this.context.log.error({ err }, 'channel message failed'));
  }

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    if (this.closed) return;
    const at = this.context.now().getTime();
    this.recent = this.recent.filter((t) => t > at - 1000);
    if (this.recent.length >= MESSAGES_PER_SECOND) {
      this.send({ v: 1, t: 'error', code: 'rate_limited' });
      return;
    }
    this.recent.push(at);
    const message = isBinary ? undefined : parse(data);
    if (!message) {
      this.send({ v: 1, t: 'error', code: 'invalid_message' });
      return;
    }
    this.enqueue(() => this.handle(message));
  };

  private async handle(message: ChannelClientMessage): Promise<void> {
    await this.attached;
    if (this.closed) return;
    const { kernels } = this.context;
    if (message.t === 'hello') {
      kernels.hello(this.session, this, message.resume);
      return;
    }
    // Every other message names a resource of the session: the scope is checked again first.
    if (!(await this.revalidate())) return;
    switch (message.t) {
      case 'execute':
        await kernels.execute(this.session, message, this);
        return;
      case 'input_reply':
        await kernels.inputReply(this.session, message, this);
        return;
      case 'interrupt': {
        const result = await kernels.interrupt(this.session);
        if (!result.ok) {
          this.send({
            v: 1,
            t: 'error',
            code: result.reason === 'connector_offline' ? 'connector_offline' : 'not_ready',
            ...(result.code && { detail: result.code }),
          });
        }
        return;
      }
    }
  }
}

/** One text frame as a channel message, or undefined for anything else. */
function parse(data: RawData): ChannelClientMessage | undefined {
  const text = Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const t = (json as { t?: unknown } | null)?.t;
  if (typeof t !== 'string' || !CHANNEL_CLIENT_TYPES.has(t)) return undefined;
  const parsed = ChannelClientMessage.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
