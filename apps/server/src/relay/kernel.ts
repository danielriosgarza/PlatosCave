import { randomUUID } from 'node:crypto';
import type {
  ChannelClientMessage,
  ChannelServerMessageInput,
  ExecutionState,
  KernelState,
  KernelView,
} from '@parallax/contracts';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { RouteDeps } from '../app';
import type { Db } from '../db/client';
import {
  bindExecution,
  type ExecutionRow,
  executionsById,
  markConnectorExecutionsUnconfirmed,
  markExecutionsUnconfirmedAtStart,
  markKernelLost,
  moveExecution,
  moveSessionExecutions,
  OPEN_EXECUTION_STATES,
  openExecutions,
  restartGeneration,
  sessionRow,
  setSessionKernel,
} from '../db/notebooks/executions';
import type { OwnedSession, SessionRow } from '../db/notebooks/sessions';
import {
  type BoundExecution,
  type DropReason,
  type ExecutionEvent,
  ExecutionMap,
  executeRequest,
  inputReply,
  isFinalExecution,
  type KernelStateEvent,
  kernelEvent,
  nextExecutionState,
  nextKernelState,
  parentOf,
  parseKernelMessage,
} from './binding';
import { OutputBuffer } from './buffer';
import {
  channelMessage,
  deleteKernel as deleteKernelRequest,
  httpMessage,
  interruptKernel as interruptKernelRequest,
  type JupyterRequest,
  kernelState as kernelStateRequest,
  restartKernel as restartKernelRequest,
  startKernel as startKernelRequest,
} from './jupyter';
import {
  type Link,
  type LinkRegistry,
  LinkRequestError,
  type LinkStream,
  type LinkTimers,
  LiveLinkRegistry,
  systemTimers,
} from './links';
import { SessionRelay } from './sessions';

/**
 * Kernels of notebook sessions on the relay (docs/design/connector.md §7, §10.5, §10.6): the
 * typed kernel operations, the one long-lived kernel channel per kernel (opened with the
 * notebook session's id as Jupyter's `session_id`, independent of any browser), the execution
 * binding and its state machine, restarts and generations, what happens when the link drops
 * and returns, the output buffer, and the browsers attached to each session.
 *
 * What it never does: resend an `execute_request`, stop a session, or show a kernel message it
 * could not match to an execution of the session's current kernel and generation.
 */

/** §4.5: the whole request has 30 s (`session`), a kernel start 20 s of that. */
const REQUEST_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
/** How long a started kernel's channel may take to open before the start still answers. */
const CHANNEL_OPEN_WAIT_MS = 10_000;
/** §10.6: after a reconnect to an idle kernel, the replay has drained after 2 s of quiet. */
export const REPLAY_DRAIN_MS = 2_000;
/** A kernel channel that keeps ending is asked again after 1 s, doubling up to 60 s. */
const RECONNECT_BACKOFF_MS = 1_000;
const MAX_RECONNECT_BACKOFF_MS = 60_000;
/** §9: at most one `activity` per 10 s per session. */
export const ACTIVITY_INTERVAL_MS = 10_000;
/** §10.3: 30 `execute` a second per session. */
export const EXECUTES_PER_SECOND = 30;
/** One kernel message is at most this large; a larger one is dropped and counted. */
const MAX_KERNEL_MESSAGE = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A browser attached to a session's channel. */
export interface ChannelPeer {
  send(message: ChannelServerMessageInput): void;
  close(code: number, reason: string): void;
}

export type KernelResult =
  | { ok: true; kernel: KernelView | null }
  | {
      ok: false;
      reason: 'not_ready' | 'kernel_exists' | 'no_kernel' | 'connector_offline' | 'kernel_failed';
      code?: string;
    };

/** What the relay holds in memory for one session's kernel. */
class SessionKernel {
  kernelId: string | null;
  kernelName: string | null;
  generation: number;
  state: KernelState = 'unknown';
  stream: LinkStream | undefined;
  /** The kernel the open stream belongs to. */
  streamKernel: string | undefined;
  channelOpen = false;
  readonly map = new ExecutionMap();
  readonly buffer = new OutputBuffer();
  readonly peers = new Set<ChannelPeer>();
  /** Peers that said `hello`: only they get live messages, after their `ready` and replay. */
  readonly listening = new Set<ChannelPeer>();
  /** Kernel `status` messages seen, so a late restart answer does not hide a newer state. */
  statusSeen = 0;
  /** When the channel was last lost while the link stayed up, and the next reconnect delay. */
  lastLossAt = Number.NEGATIVE_INFINITY;
  backoffMs = RECONNECT_BACKOFF_MS;
  cancelBackoff: (() => void) | undefined;
  /** The execution waiting on an `input_request`, and that request's header. */
  prompt: { executionId: string; header: Record<string, unknown> } | undefined;
  /** Kernel messages and bindings are applied one at a time, in order. */
  chain: Promise<void> = Promise.resolve();
  reconnecting = false;
  cancelDrain: (() => void) | undefined;
  onDrained: (() => void) | undefined;
  lastActivityAt = Number.NEGATIVE_INFINITY;
  executes: number[] = [];
  incoming: Buffer[] = [];
  incomingBytes = 0;
  incomingTooLarge = false;
  waitOpen: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    public connectorId: string,
    row: SessionRow,
  ) {
    this.kernelId = row.kernelId;
    this.kernelName = row.kernelName;
    this.generation = row.kernelGeneration;
  }

  view(): KernelView | null {
    if (!this.kernelId) return null;
    return {
      id: this.kernelId,
      name: this.kernelName ?? '',
      state: this.state,
      generation: this.generation,
    };
  }
}

const toBound = (row: ExecutionRow): BoundExecution => ({
  id: row.id,
  msgId: row.msgId,
  ref: row.clientRef,
  cellId: row.cellId,
  seq: row.seq,
  kernelId: row.kernelId,
  generation: row.kernelGeneration,
  state: row.state,
  executionCount: row.executionCount ?? undefined,
  outputsIncomplete: row.outputsIncomplete,
});

const executionMessage = (e: {
  id: string;
  ref: string;
  cellId: string;
  seq: number;
  state: ExecutionState;
  executionCount?: number | null | undefined;
  outputsIncomplete: boolean;
  generation: number;
}): ChannelServerMessageInput => ({
  v: 1,
  t: 'execution',
  executionId: e.id,
  ref: e.ref,
  cellId: e.cellId,
  seq: e.seq,
  state: e.state,
  ...(e.executionCount != null && { executionCount: e.executionCount }),
  outputsIncomplete: e.outputsIncomplete,
  generation: e.generation,
});

const rowMessage = (row: ExecutionRow) =>
  executionMessage({
    id: row.id,
    ref: row.clientRef,
    cellId: row.cellId,
    seq: row.seq,
    state: row.state,
    executionCount: row.executionCount,
    outputsIncomplete: row.outputsIncomplete,
    generation: row.kernelGeneration,
  });

const OPEN_SESSION = new Set(['starting', 'ready', 'disconnected', 'unconfirmed', 'stopping']);

/** The answer of one Jupyter REST call made through a link. */
interface JupyterAnswer {
  status: number;
  body: Buffer;
}

export class KernelRelay {
  private readonly kernels = new Map<string, SessionKernel>();
  /** Kernel messages dropped by reason (§10.6: counted, never shown). */
  readonly dropped: Record<DropReason | 'too_large', number> = {
    unparsable: 0,
    unknown_parent: 0,
    other_kernel: 0,
    old_generation: 0,
    too_large: 0,
  };
  private started: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      db: Db;
      links: LinkRegistry;
      sessions: SessionRelay;
      timers: LinkTimers;
      now: () => Date;
      log: FastifyBaseLogger;
    },
  ) {}

  private get db() {
    return this.options.db;
  }
  private get now() {
    return this.options.now();
  }

  /**
   * Treats every in-flight execution as `unconfirmed` (this process holds nothing about them)
   * and follows the links and the sessions. Returns the unsubscribe.
   */
  start(registry: LiveLinkRegistry): () => void {
    this.started = markExecutionsUnconfirmedAtStart(this.db).then(
      () => undefined,
      (err) => this.options.log.error({ err }, 'marking executions unconfirmed at start failed'),
    );
    const offLinks = registry.on({ close: (link) => this.linkClosed(link.connectorId) });
    const offSessions = this.options.sessions.onChange((id) => this.sessionChanged(id));
    return () => {
      offLinks();
      offSessions();
      for (const kernel of this.kernels.values()) this.dispose(kernel);
    };
  }

  /** Waits until the work queued for `sessionId` is done (tests). */
  async settled(sessionId: string): Promise<void> {
    await this.started;
    for (;;) {
      const chain = this.kernels.get(sessionId)?.chain;
      await chain;
      if (this.kernels.get(sessionId)?.chain === chain) return;
    }
  }

  /** The in-memory record of `row`'s kernel, created from the row when there is none. */
  private kernelFor(row: SessionRow): SessionKernel {
    let kernel = this.kernels.get(row.id);
    if (!kernel) {
      kernel = new SessionKernel(row.id, row.connectorId, row);
      this.kernels.set(row.id, kernel);
    }
    return kernel;
  }

  /** Runs `task` after everything already queued for `kernel`. */
  private serial(kernel: SessionKernel, task: () => Promise<void>): Promise<void> {
    const next = kernel.chain
      .then(task)
      .catch((err) =>
        this.options.log.error({ err, sessionId: kernel.sessionId }, 'kernel update failed'),
      );
    kernel.chain = next;
    return next;
  }

  private broadcast(kernel: SessionKernel, message: ChannelServerMessageInput): void {
    for (const peer of kernel.listening) {
      try {
        peer.send(message);
      } catch (err) {
        this.options.log.warn({ err }, 'sending to a browser channel failed');
      }
    }
  }

  private setKernelState(kernel: SessionKernel, event: KernelStateEvent): void {
    const next = nextKernelState(kernel.state, event);
    if (next === kernel.state) return;
    kernel.state = next;
    this.broadcast(kernel, { v: 1, t: 'kernel_state', state: next, generation: kernel.generation });
  }

  // ── browsers ─────────────────────────────────────────────────────────────────────────────

  /**
   * A browser attached to `session`'s channel: the connector hears `presence { attached: true }`
   * when it is the first (§9). The `hello` that follows gets `ready` and the replay.
   */
  async attach(session: OwnedSession, peer: ChannelPeer): Promise<void> {
    await this.started;
    const kernel = this.kernelFor(session);
    const first = kernel.peers.size === 0;
    kernel.peers.add(peer);
    if (first) this.options.sessions.presence(session, true);
    this.maybeReconnect(kernel, session);
  }

  /** The browser left; the last one leaving makes the session detached for the connector. */
  detach(session: OwnedSession, peer: ChannelPeer): void {
    const kernel = this.kernels.get(session.id);
    kernel?.listening.delete(peer);
    if (!kernel?.peers.delete(peer)) return;
    if (kernel.peers.size === 0) this.options.sessions.presence(session, false);
  }

  /**
   * `hello` (§10.5): `ready` with the epoch, the last event number, the session and the kernel,
   * then the open executions, the rows of the finished ones the browser may not know the end of
   * (those with events in the replay, and those that finished after its position), and the
   * output events it has not seen. A browser from another epoch gets everything still held and
   * treats the rest as incomplete.
   */
  async hello(
    session: OwnedSession,
    peer: ChannelPeer,
    resume: { epoch: string; afterEventSeq: number } | undefined,
  ): Promise<void> {
    const kernel = this.kernelFor(session);
    // Taken in the kernel's order, so no live message slips between the replay and the stream.
    await this.serial(kernel, async () => {
      const replay = kernel.buffer.replay(resume);
      const ids = new Set([
        ...replay.events.map((e) => e.executionId),
        ...kernel.buffer.finishedSince(resume),
        ...replay.truncated,
      ]);
      const closed = [...ids].filter((id) => !kernel.map.byId(id));
      const finished = closed.length > 0 ? await executionsById(this.db, session.id, closed) : [];
      this.sendHello(kernel, session, peer, replay, finished);
    });
  }

  private sendHello(
    kernel: SessionKernel,
    session: OwnedSession,
    peer: ChannelPeer,
    replay: ReturnType<OutputBuffer['replay']>,
    finished: ExecutionRow[],
  ): void {
    if (!kernel.peers.has(peer)) return;
    peer.send({
      v: 1,
      t: 'ready',
      epoch: kernel.buffer.epoch,
      eventSeq: kernel.buffer.eventSeq,
      session: {
        state: session.state,
        cause: session.cause,
        owned: session.owned,
        lease: session.lease,
      },
      kernel: kernel.view(),
    });
    for (const execution of kernel.map.all()) peer.send(executionMessage(execution));
    // Before the output, so the browser can place it; one whose output was all dropped from the
    // buffer is incomplete for this browser.
    const truncated = new Set(replay.truncated);
    for (const row of finished) {
      peer.send(rowMessage(truncated.has(row.id) ? { ...row, outputsIncomplete: true } : row));
    }
    for (const event of replay.events) peer.send(event);
    for (const id of replay.truncated) {
      const execution = kernel.map.byId(id);
      if (execution) peer.send(executionMessage({ ...execution, outputsIncomplete: true }));
    }
    kernel.listening.add(peer);
  }

  // ── execute, input and interrupt from the channel ────────────────────────────────────────

  /**
   * `execute` (§10.6): binds the cell to the session's current kernel and generation, then
   * writes the `execute_request` once. A ref already bound answers with its row and sends
   * nothing.
   */
  execute(
    session: OwnedSession,
    message: Extract<ChannelClientMessage, { t: 'execute' }>,
    peer: ChannelPeer,
  ): Promise<void> {
    const kernel = this.kernelFor(session);
    const at = this.now.getTime();
    kernel.executes = kernel.executes.filter((t) => t > at - 1000);
    if (kernel.executes.length >= EXECUTES_PER_SECOND) {
      peer.send({ v: 1, t: 'error', code: 'rate_limited', ref: message.ref });
      return Promise.resolve();
    }
    kernel.executes.push(at);
    return this.serial(kernel, async () => {
      const usable =
        session.state === 'ready' &&
        kernel.kernelId !== null &&
        kernel.channelOpen &&
        kernel.stream !== undefined &&
        (kernel.state === 'idle' || kernel.state === 'busy');
      const stream = kernel.stream;
      const kernelId = kernel.kernelId;
      const result = await bindExecution(
        this.db,
        session,
        usable && stream && kernelId ? { id: kernelId, generation: kernel.generation } : null,
        {
          ref: message.ref,
          cellId: message.cellId,
          workingCopyRevision: message.workingCopyRevision,
          code: message.code,
          msgId: randomUUID(),
        },
        this.now,
      );
      if (result.kind === 'existing') {
        peer.send(rowMessage(result.row));
        return;
      }
      if (result.kind === 'not_ready' || !stream) {
        peer.send({ v: 1, t: 'error', code: 'not_ready', ref: message.ref });
        return;
      }
      const bound = toBound(result.row);
      kernel.map.add(bound);
      this.broadcast(kernel, executionMessage(bound));
      this.activity(kernel);
      // Written once, after the commit; a failed write leaves the execution unconfirmed.
      stream
        .write(
          Buffer.from(executeRequest(bound.msgId, session.id, message.code, this.now), 'utf8'),
          { end: true, text: true },
        )
        .catch(() =>
          this.serial(kernel, () => this.executionEvent(kernel, bound, { t: 'write_failed' })),
        );
    });
  }

  /** `input_reply`: accepted only for the execution that owns the open prompt. */
  inputReply(
    session: OwnedSession,
    message: Extract<ChannelClientMessage, { t: 'input_reply' }>,
    peer: ChannelPeer,
  ): Promise<void> {
    const kernel = this.kernelFor(session);
    return this.serial(kernel, async () => {
      const prompt = kernel.prompt;
      if (!prompt || prompt.executionId !== message.executionId || !kernel.stream) {
        peer.send({ v: 1, t: 'error', code: 'not_waiting_for_input' });
        return;
      }
      kernel.prompt = undefined;
      this.setKernelState(kernel, { t: 'input_replied' });
      kernel.stream
        .write(
          Buffer.from(
            inputReply(randomUUID(), session.id, prompt.header, message.value, this.now),
            'utf8',
          ),
          { end: true, text: true },
        )
        .catch((err) => this.options.log.info({ err }, 'writing an input reply failed'));
    });
  }

  // ── typed kernel operations (routes and channel) ─────────────────────────────────────────

  /** The session's kernel as the relay knows it. */
  async kernel(session: OwnedSession): Promise<KernelView | null> {
    await this.started;
    const kernel = this.kernels.get(session.id);
    if (kernel) return kernel.view();
    if (!session.kernelId) return null;
    return {
      id: session.kernelId,
      name: session.kernelName ?? '',
      state: 'unknown',
      generation: session.kernelGeneration,
    };
  }

  /** Starts a kernel of `kernelName` and opens its channel (§7). */
  async startKernel(session: OwnedSession, kernelName: string): Promise<KernelResult> {
    await this.started;
    if (session.state !== 'ready') return { ok: false, reason: 'not_ready' };
    const kernel = this.kernelFor(session);
    if (kernel.kernelId || session.kernelId) return { ok: false, reason: 'kernel_exists' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    const answer = await this.call(
      link,
      session.id,
      startKernelRequest(kernelName),
      START_TIMEOUT_MS,
    );
    if (!answer.ok) return answer;
    const body = jsonOf(answer.value.body);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (answer.value.status !== 201 && answer.value.status !== 200) {
      return { ok: false, reason: 'kernel_failed', code: `jupyter_${answer.value.status}` };
    }
    if (!UUID.test(id)) return { ok: false, reason: 'kernel_failed', code: 'kernel_start_failed' };
    const name = typeof body?.name === 'string' ? body.name : kernelName;
    const reported = jupyterState(body?.execution_state) ?? 'starting';
    let lost = false;
    await this.serial(kernel, async () => {
      // Another start may have won while Jupyter answered (a double click): keep the first.
      const set = kernel.kernelId
        ? null
        : await setSessionKernel(this.db, session.id, { id, name }, this.now);
      if (!set) {
        lost = true;
        return;
      }
      this.closeStream(kernel);
      kernel.map.clear();
      kernel.prompt = undefined;
      kernel.kernelId = id;
      kernel.kernelName = name;
      kernel.generation = set.session.kernelGeneration;
      kernel.state = reported;
      this.openChannel(kernel, link);
      this.broadcast(kernel, {
        v: 1,
        t: 'kernel_state',
        state: kernel.state,
        generation: kernel.generation,
      });
      this.activity(kernel);
    });
    if (lost) {
      void this.call(link, session.id, deleteKernelRequest(id));
      return { ok: false, reason: 'kernel_exists' };
    }
    await this.waitChannel(kernel);
    return { ok: true, kernel: kernel.view() };
  }

  /** Shuts the kernel down; its unfinished executions become `aborted`. */
  async deleteKernel(session: OwnedSession): Promise<KernelResult> {
    await this.started;
    const kernel = this.kernelFor(session);
    const kernelId = kernel.kernelId;
    if (!kernelId) return { ok: false, reason: 'no_kernel' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    const answer = await this.call(link, session.id, deleteKernelRequest(kernelId));
    if (!answer.ok) return answer;
    if (answer.value.status >= 300 && answer.value.status !== 404) {
      return { ok: false, reason: 'kernel_failed', code: `jupyter_${answer.value.status}` };
    }
    await this.serial(kernel, async () => {
      if (kernel.kernelId !== kernelId) return;
      const set = await setSessionKernel(this.db, session.id, null, this.now);
      this.closeStream(kernel);
      this.forgetExecutions(kernel, set?.aborted ?? []);
      kernel.kernelId = null;
      kernel.state = 'unknown';
      kernel.prompt = undefined;
      this.activity(kernel);
    });
    return { ok: true, kernel: null };
  }

  /** Asks the kernel to stop its current operation. */
  async interrupt(session: OwnedSession): Promise<KernelResult> {
    await this.started;
    const kernel = this.kernelFor(session);
    const kernelId = kernel.kernelId;
    if (!kernelId) return { ok: false, reason: 'no_kernel' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    this.activity(kernel);
    const answer = await this.call(link, session.id, interruptKernelRequest(kernelId));
    if (!answer.ok) return answer;
    if (answer.value.status >= 300) {
      return { ok: false, reason: 'kernel_failed', code: `jupyter_${answer.value.status}` };
    }
    return { ok: true, kernel: kernel.view() };
  }

  /**
   * Restart (§10.6): calls the API, then increases the generation and aborts every unfinished
   * execution; nothing is run again. Late output of the old generation is dropped.
   */
  async restart(session: OwnedSession): Promise<KernelResult> {
    await this.started;
    const kernel = this.kernelFor(session);
    const kernelId = kernel.kernelId;
    if (!kernelId) return { ok: false, reason: 'no_kernel' };
    const link = this.options.links.get(session.connectorId);
    if (!link) return { ok: false, reason: 'connector_offline' };
    this.activity(kernel);
    const seen = kernel.statusSeen;
    const answer = await this.call(link, session.id, restartKernelRequest(kernelId));
    if (!answer.ok) return answer;
    if (answer.value.status >= 300) {
      return { ok: false, reason: 'kernel_failed', code: `jupyter_${answer.value.status}` };
    }
    await this.serial(kernel, async () => {
      const restarted = await restartGeneration(this.db, session.id, kernelId, this.now);
      if (!restarted) return;
      kernel.generation = restarted.session.kernelGeneration;
      kernel.prompt = undefined;
      this.forgetExecutions(kernel, restarted.aborted);
      // A status the restarted kernel already sent (idle) is newer than the restart's answer.
      if (kernel.statusSeen === seen) kernel.state = 'restarting';
      this.broadcast(kernel, {
        v: 1,
        t: 'kernel_state',
        state: kernel.state,
        generation: kernel.generation,
      });
    });
    return { ok: true, kernel: kernel.view() };
  }

  // ── the kernel channel ───────────────────────────────────────────────────────────────────

  /**
   * Opens the one kernel channel of the current kernel (§7), with the notebook session id as
   * Jupyter's `session_id`, so Jupyter replays what it buffered while no client was connected.
   */
  private openChannel(kernel: SessionKernel, link: Link): void {
    const kernelId = kernel.kernelId;
    if (!kernelId) return;
    kernel.incoming = [];
    kernel.incomingBytes = 0;
    kernel.incomingTooLarge = false;
    let stream: LinkStream | undefined;
    try {
      stream = link.openStream(
        kernel.sessionId,
        (streamId) => channelMessage(kernelId, streamId, kernel.sessionId),
        {
          onControl: (message) => {
            if (message.t === 'ws_opened' && kernel.stream === stream) {
              kernel.channelOpen = true;
              kernel.backoffMs = RECONNECT_BACKOFF_MS;
              for (const resolve of kernel.waitOpen.splice(0)) resolve();
            }
          },
          onData: (payload, flags) => {
            if (kernel.stream !== stream || !stream) return;
            this.receive(kernel, kernelId, payload, flags.end);
            stream.grant(payload.length);
          },
          onClose: ({ code }) => {
            if (stream) this.channelClosed(kernel, stream, code);
          },
        },
      );
    } catch (err) {
      this.options.log.warn(
        { err, sessionId: kernel.sessionId },
        'opening the kernel channel failed',
      );
      return;
    }
    kernel.stream = stream;
    kernel.streamKernel = kernelId;
    kernel.channelOpen = false;
  }

  private waitChannel(kernel: SessionKernel): Promise<void> {
    if (kernel.channelOpen || !kernel.stream) return Promise.resolve();
    return new Promise((resolve) => {
      const cancel = this.options.timers.after(CHANNEL_OPEN_WAIT_MS, done);
      function done() {
        cancel?.();
        resolve();
      }
      kernel.waitOpen.push(done);
    });
  }

  /** Our own close of the channel (new kernel, shut down, session ended): no loss follows. */
  private closeStream(kernel: SessionKernel): void {
    const stream = kernel.stream;
    kernel.stream = undefined;
    kernel.streamKernel = undefined;
    kernel.channelOpen = false;
    kernel.cancelDrain?.();
    stream?.closeWebSocket(1000, 'closed');
  }

  /** Assembles WebSocket messages from frames (END marks the last frame of one). */
  private receive(kernel: SessionKernel, kernelId: string, payload: Buffer, end: boolean): void {
    if (!kernel.incomingTooLarge) {
      kernel.incomingBytes += payload.length;
      if (kernel.incomingBytes > MAX_KERNEL_MESSAGE) {
        kernel.incomingTooLarge = true;
        kernel.incoming = [];
      } else {
        kernel.incoming.push(payload);
      }
    }
    if (!end) return;
    const tooLarge = kernel.incomingTooLarge;
    const text = Buffer.concat(kernel.incoming).toString('utf8');
    kernel.incoming = [];
    kernel.incomingBytes = 0;
    kernel.incomingTooLarge = false;
    if (tooLarge) {
      this.drop(kernel, 'too_large');
      return;
    }
    void this.serial(kernel, () => this.kernelMessage(kernel, kernelId, text));
  }

  private drop(kernel: SessionKernel, reason: DropReason | 'too_large'): void {
    this.dropped[reason]++;
    this.options.log.debug(
      { sessionId: kernel.sessionId, reason, relay_dropped_kernel_messages: this.dropped },
      'kernel message dropped',
    );
  }

  /** One kernel message, matched by `parent_header.msg_id` (§10.6). */
  private async kernelMessage(kernel: SessionKernel, channelKernel: string, text: string) {
    kernel.onDrained?.();
    const message = parseKernelMessage(text);
    if (!message) return this.drop(kernel, 'unparsable');
    const event = kernelEvent(message);
    if (event.t === 'ignored') return;
    const matched = kernel.map.match(parentOf(message), channelKernel, {
      kernelId: kernel.kernelId,
      generation: kernel.generation,
    });
    if (event.t === 'status') {
      // The kernel's own state, whoever asked; an execution moves only when it is the parent.
      if (channelKernel === kernel.kernelId) {
        kernel.statusSeen++;
        this.setKernelState(kernel, { t: 'reported', state: event.state });
      }
      if (matched.ok && event.state === 'busy') {
        await this.executionEvent(kernel, matched.execution, { t: 'busy' });
      }
      return;
    }
    if (!matched.ok) return this.drop(kernel, matched.reason);
    const execution = matched.execution;
    switch (event.t) {
      case 'output':
      case 'clear_output':
      case 'input_request': {
        if (event.t === 'input_request') {
          kernel.prompt = { executionId: execution.id, header: message.header };
          this.setKernelState(kernel, { t: 'input_request' });
        }
        const sent = kernel.buffer.append({
          executionId: execution.id,
          generation: execution.generation,
          kind: event.t === 'output' ? 'output' : event.t,
          ...(event.t === 'output' && { output: event.output }),
          ...(event.t === 'input_request' && {
            input: { prompt: event.prompt, password: event.password },
          }),
        });
        this.broadcast(kernel, sent);
        return;
      }
      case 'reply':
        if (kernel.prompt?.executionId === execution.id) kernel.prompt = undefined;
        await this.executionEvent(
          kernel,
          execution,
          { t: 'reply', status: event.status },
          event.executionCount,
        );
        return;
    }
  }

  /**
   * Applies one event to one execution, in the database first; a final state forgets it. A
   * transition out of `unconfirmed` marks its output incomplete: what was emitted while the
   * relay could not hear the kernel may be missing.
   */
  private async executionEvent(
    kernel: SessionKernel,
    execution: BoundExecution,
    event: ExecutionEvent,
    executionCount?: number,
  ): Promise<void> {
    const next = nextExecutionState(execution.state, event);
    if (!next) return;
    const from = OPEN_EXECUTION_STATES.filter((s) => nextExecutionState(s, event) === next);
    const incomplete = execution.state === 'unconfirmed' && next !== 'aborted';
    const row = await moveExecution(this.db, execution.id, from, next, this.now, {
      executionCount,
      ...(incomplete && { outputsIncomplete: true }),
    });
    if (!row) return;
    this.applyRow(kernel, row);
  }

  /** Mirrors a changed row in memory and tells the browsers. */
  private applyRow(kernel: SessionKernel, row: ExecutionRow): void {
    const bound = kernel.map.get(row.msgId);
    if (bound) {
      bound.state = row.state;
      bound.executionCount = row.executionCount ?? undefined;
      bound.outputsIncomplete = row.outputsIncomplete;
    }
    if (isFinalExecution(row.state)) {
      kernel.map.remove(row.msgId);
      kernel.buffer.finish(row.id);
      if (kernel.prompt?.executionId === row.id) kernel.prompt = undefined;
    }
    this.broadcast(kernel, rowMessage(row));
  }

  private forgetExecutions(kernel: SessionKernel, rows: ExecutionRow[]): void {
    for (const row of rows) this.applyRow(kernel, row);
    kernel.map.clear();
  }

  /**
   * The kernel channel closed without us closing it: the link dropped, or the connector or
   * Jupyter ended the stream. In-flight executions become `unconfirmed`; while the link is up
   * the kernel is asked again at once.
   */
  private channelClosed(kernel: SessionKernel, stream: LinkStream, code: string): void {
    if (kernel.stream !== stream) return;
    kernel.stream = undefined;
    kernel.streamKernel = undefined;
    kernel.channelOpen = false;
    kernel.cancelDrain?.();
    for (const resolve of kernel.waitOpen.splice(0)) resolve();
    this.setKernelState(kernel, { t: 'lost' });
    void this.serial(kernel, async () => {
      const rows = await moveSessionExecutions(
        this.db,
        kernel.sessionId,
        ['sent', 'running'],
        'unconfirmed',
        this.now,
      );
      for (const row of rows) this.applyRow(kernel, row);
    }).then(() => {
      if (code === 'connector_offline') return;
      // Asked again at once, unless the channel keeps ending: then after a growing delay.
      const at = this.now.getTime();
      const again = at - kernel.lastLossAt < MAX_RECONNECT_BACKOFF_MS;
      kernel.lastLossAt = at;
      const retry = () =>
        void sessionRow(this.db, kernel.sessionId).then((row) => {
          if (row) this.maybeReconnect(kernel, row);
        });
      if (!again) {
        retry();
        return;
      }
      const delay = kernel.backoffMs;
      kernel.backoffMs = Math.min(delay * 2, MAX_RECONNECT_BACKOFF_MS);
      kernel.cancelBackoff?.();
      kernel.cancelBackoff = this.options.timers.after(delay, () => {
        kernel.cancelBackoff = undefined;
        retry();
      });
    });
  }

  /** The link to a connector closed (§10.6): its sessions' in-flight executions are unconfirmed. */
  private linkClosed(connectorId: string): void {
    void (async () => {
      await this.started;
      const rows = await markConnectorExecutionsUnconfirmed(this.db, connectorId);
      for (const row of rows) {
        const kernel = this.kernels.get(row.sessionId);
        if (kernel) this.applyRow(kernel, row);
      }
    })().catch((err) =>
      this.options.log.error({ err, connectorId }, 'marking executions unconfirmed failed'),
    );
  }

  /**
   * A session changed (the session relay applied a report or a deadline): the browsers hear its
   * state; a session that ended closes their channels; a session back to `ready` whose kernel
   * channel is down asks the kernel again (after the link returned or the relay restarted).
   */
  private sessionChanged(sessionId: string): void {
    void sessionRow(this.db, sessionId)
      .then((row) => {
        if (!row) return;
        let kernel = this.kernels.get(sessionId);
        if (!kernel && row.state === 'ready' && row.kernelId) kernel = this.kernelFor(row);
        if (!kernel) return;
        kernel.connectorId = row.connectorId;
        this.broadcast(kernel, {
          v: 1,
          t: 'session_state',
          state: row.state,
          cause: row.cause,
          ...(row.leaseExpiresAt && { leaseExpiresAt: row.leaseExpiresAt.toISOString() }),
        });
        if (!OPEN_SESSION.has(row.state)) {
          for (const peer of kernel.peers) peer.close(4410, 'session_closed');
          this.dispose(kernel);
          this.kernels.delete(sessionId);
          return;
        }
        this.maybeReconnect(kernel, row);
      })
      .catch((err) => this.options.log.error({ err, sessionId }, 'session change failed'));
  }

  private dispose(kernel: SessionKernel): void {
    this.closeStream(kernel);
    kernel.cancelBackoff?.();
    kernel.peers.clear();
    kernel.listening.clear();
  }

  /** Asks the kernel again when the session is ready, it has a kernel and its channel is down. */
  private maybeReconnect(kernel: SessionKernel, row: SessionRow): void {
    if (row.state !== 'ready' || !row.kernelId || kernel.stream || kernel.reconnecting) return;
    const link = this.options.links.get(row.connectorId);
    if (!link) return;
    kernel.reconnecting = true;
    void this.reconnect(kernel, row, link).finally(() => {
      kernel.reconnecting = false;
    });
  }

  /**
   * After the link returns, or the relay restarted (§10.6): `GET /api/kernels/{id}`. A 404 means
   * the kernel is lost: its executions are `incomplete` and a new kernel must be started
   * explicitly. Otherwise the channel is reopened with the same `session_id`, so Jupyter
   * replays what it buffered; a busy kernel's executions run on with their output marked
   * incomplete, an idle kernel's ones are `incomplete` unless the replay brings their reply
   * within 2 s. Nothing is executed again.
   */
  private async reconnect(kernel: SessionKernel, row: SessionRow, link: Link): Promise<void> {
    const kernelId = row.kernelId;
    if (!kernelId) return;
    const answer = await this.call(link, row.id, kernelStateRequest(kernelId));
    if (!answer.ok) {
      this.options.log.info({ sessionId: row.id, reason: answer.reason }, 'kernel query failed');
      return;
    }
    if (answer.value.status === 404) {
      await this.serial(kernel, async () => {
        const lost = await markKernelLost(this.db, row.id, kernelId, this.now);
        if (!lost) return;
        kernel.kernelId = null;
        kernel.prompt = undefined;
        kernel.state = 'unknown';
        this.forgetExecutions(kernel, lost.incomplete);
        this.broadcast(kernel, {
          v: 1,
          t: 'session_state',
          state: lost.session.state,
          cause: lost.session.cause,
        });
      });
      return;
    }
    if (answer.value.status >= 300) {
      this.options.log.info(
        { sessionId: row.id, status: answer.value.status },
        'kernel query answered an error',
      );
      return;
    }
    const reported = jupyterState(jsonOf(answer.value.body)?.execution_state) ?? 'idle';
    await this.serial(kernel, async () => {
      const current = await sessionRow(this.db, row.id);
      if (!current || current.kernelId !== kernelId || kernel.stream) return;
      kernel.kernelId = kernelId;
      kernel.kernelName = current.kernelName;
      kernel.generation = current.kernelGeneration;
      kernel.map.clear();
      for (const open of await openExecutions(this.db, row.id)) {
        if (open.kernelId === kernelId && open.kernelGeneration === kernel.generation) {
          kernel.map.add(toBound(open));
        }
      }
      this.setKernelState(kernel, { t: 'reported', state: reported });
      if (reported === 'busy' || reported === 'starting') {
        const rows = await moveSessionExecutions(
          this.db,
          row.id,
          ['unconfirmed'],
          'running',
          this.now,
          { outputsIncomplete: true },
        );
        for (const moved of rows) this.applyRow(kernel, moved);
      }
      this.openChannel(kernel, link);
      if (reported === 'idle' || reported === 'dead') this.armDrain(kernel);
    });
  }

  /**
   * §10.6: after a reconnect to an idle kernel, the unconfirmed executions still without a reply
   * once the replay has been quiet for 2 s are `incomplete`: their outcome is unknown.
   */
  private armDrain(kernel: SessionKernel): void {
    kernel.cancelDrain?.();
    const arm = () => {
      kernel.cancelDrain?.();
      kernel.cancelDrain = this.options.timers.after(REPLAY_DRAIN_MS, () => {
        kernel.cancelDrain = undefined;
        kernel.onDrained = undefined;
        void this.serial(kernel, async () => {
          // Only the executions that were in flight when the link dropped: a cell run since the
          // reconnect is live, however quiet it is.
          const rows = await moveSessionExecutions(
            this.db,
            kernel.sessionId,
            ['unconfirmed'],
            'incomplete',
            this.now,
            { outputsIncomplete: true },
          );
          for (const row of rows) this.applyRow(kernel, row);
        });
      });
    };
    kernel.onDrained = arm;
    arm();
  }

  /** `activity` to the connector (§9), at most every 10 s per session. */
  private activity(kernel: SessionKernel): void {
    const at = this.now.getTime();
    if (at - kernel.lastActivityAt < ACTIVITY_INTERVAL_MS) return;
    const link = this.options.links.get(kernel.connectorId);
    if (!link) return;
    kernel.lastActivityAt = at;
    try {
      link.send({ v: 1, t: 'activity', sessionId: kernel.sessionId });
    } catch (err) {
      this.options.log.info({ err }, 'sending activity failed');
    }
  }

  /** One Jupyter REST call through the link (§7), answered by its status and body. */
  private call(
    link: Link,
    sessionId: string,
    request: JupyterRequest,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<
    | { ok: true; value: JupyterAnswer }
    | { ok: false; reason: 'connector_offline' | 'kernel_failed'; code?: string }
  > {
    return new Promise((resolve) => {
      let status = 0;
      const chunks: Buffer[] = [];
      let done = false;
      let cancel: () => void = () => {};
      const finish = (
        result:
          | { ok: true; value: JupyterAnswer }
          | { ok: false; reason: 'connector_offline' | 'kernel_failed'; code?: string },
      ) => {
        if (done) return;
        done = true;
        cancel();
        resolve(result);
      };
      let stream: LinkStream;
      try {
        stream = link.openStream(sessionId, (id) => httpMessage(request, id, sessionId), {
          onControl: (message) => {
            if (message.t === 'http_head') status = message.status;
          },
          onData: (payload) => {
            chunks.push(payload);
            stream.grant(payload.length);
          },
          onClose: ({ code }) => {
            if (code === 'done' && status > 0) {
              finish({ ok: true, value: { status, body: Buffer.concat(chunks) } });
            } else if (code === 'connector_offline') {
              finish({ ok: false, reason: 'connector_offline' });
            } else {
              finish({ ok: false, reason: 'kernel_failed', code });
            }
          },
        });
      } catch (err) {
        const code = err instanceof LinkRequestError ? err.code : 'internal';
        finish(
          code === 'connector_offline'
            ? { ok: false, reason: 'connector_offline' }
            : { ok: false, reason: 'kernel_failed', code },
        );
        return;
      }
      cancel = this.options.timers.after(timeoutMs, () => {
        stream.reset('stream_cancelled', 'request deadline');
        finish({ ok: false, reason: 'kernel_failed', code: 'test_timeout' });
      });
      if (request.body) {
        stream.write(request.body, { end: true }).catch(() => undefined);
      }
    });
  }
}

const jsonOf = (body: Buffer): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const jupyterState = (value: unknown) =>
  value === 'starting' ||
  value === 'idle' ||
  value === 'busy' ||
  value === 'restarting' ||
  value === 'dead'
    ? value
    : undefined;

/** The session and kernel relays of one app, shared by the relay route modules. */
export interface NotebookRelays {
  sessions: SessionRelay;
  kernels: KernelRelay;
}

const relaysByApp = new WeakMap<RouteDeps['links'], NotebookRelays>();

/**
 * The notebook relays of this app (one per live-link registry), created and started by the first
 * route module that asks; undefined without a database.
 */
export function notebookRelays(app: FastifyInstance, deps: RouteDeps): NotebookRelays | undefined {
  if (!deps.db) return undefined;
  const known = relaysByApp.get(deps.links);
  if (known) return known;
  const timers = deps.links instanceof LiveLinkRegistry ? deps.links.timers : systemTimers;
  const sessions = new SessionRelay({
    db: deps.db,
    links: deps.links,
    timers,
    now: deps.now,
    log: app.log.child({ component: 'sessions' }),
  });
  const kernels = new KernelRelay({
    db: deps.db,
    links: deps.links,
    sessions,
    timers,
    now: deps.now,
    log: app.log.child({ component: 'kernels' }),
  });
  const relays = { sessions, kernels };
  relaysByApp.set(deps.links, relays);
  if (deps.links instanceof LiveLinkRegistry) {
    const stopSessions = sessions.start(deps.links);
    const stopKernels = kernels.start(deps.links);
    app.addHook('onClose', async () => {
      stopKernels();
      stopSessions();
    });
  }
  return relays;
}

/** The kernel relay following each live registry, so tests can wait for it to settle. */
export const kernelRelays = (links: LinkRegistry) => relaysByApp.get(links)?.kernels;
