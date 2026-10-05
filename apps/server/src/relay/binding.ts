import type { ExecutionState, KernelState, LiveOutput } from '@parallax/contracts';
import { z } from 'zod';

/**
 * Execution binding (docs/design/connector.md §10.6): the Jupyter messages the relay writes on a
 * kernel channel, how it reads what comes back, and the pure state machines of executions and
 * of the kernel. Every kernel message is matched by `parent_header.msg_id` to an execution the
 * relay itself bound to the session's current kernel and generation; anything else is dropped
 * and counted, never shown.
 */

// ── Jupyter messages (kernel WebSocket protocol, JSON text dialect) ────────────────────────

const Header = z.looseObject({
  msg_id: z.string().max(256),
  msg_type: z.string().max(64),
});
/** A kernel message as the relay reads it: everything else in it is untrusted and unread. */
export const KernelMessage = z.looseObject({
  header: Header,
  parent_header: z.union([z.looseObject({ msg_id: z.string().max(256).optional() }), z.null()]),
  content: z.record(z.string(), z.unknown()),
  channel: z.string().max(16).optional(),
});
export type KernelMessage = z.infer<typeof KernelMessage>;

/** Parses one text message from the kernel channel; null for anything that is not one. */
export function parseKernelMessage(text: string): KernelMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = KernelMessage.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export const parentOf = (message: KernelMessage): string | undefined =>
  message.parent_header?.msg_id || undefined;

const header = (msgId: string, msgType: string, sessionId: string, now: Date) => ({
  msg_id: msgId,
  msg_type: msgType,
  session: sessionId,
  username: '',
  date: now.toISOString(),
  version: '5.3',
});

/**
 * The `execute_request` of one bound execution (§10.6 step 3): header `msg_id` and `session` =
 * the notebook session id; stdin allowed, stop on error.
 */
export function executeRequest(msgId: string, sessionId: string, code: string, now: Date): string {
  return JSON.stringify({
    header: header(msgId, 'execute_request', sessionId, now),
    parent_header: {},
    metadata: {},
    content: {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: true,
      stop_on_error: true,
    },
    buffers: [],
    channel: 'shell',
  });
}

/** The `input_reply` to the prompt whose message header is `prompt`. */
export function inputReply(
  msgId: string,
  sessionId: string,
  prompt: Record<string, unknown>,
  value: string,
  now: Date,
): string {
  return JSON.stringify({
    header: header(msgId, 'input_reply', sessionId, now),
    parent_header: prompt,
    metadata: {},
    content: { value },
    buffers: [],
    channel: 'stdin',
  });
}

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter((v) => typeof v === 'string').join('')
      : '';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** What one kernel message means for its execution. */
export type KernelEvent =
  | { t: 'status'; state: 'busy' | 'idle' | 'starting' | 'restarting' | 'dead' }
  | { t: 'output'; output: LiveOutput }
  | { t: 'clear_output' }
  | { t: 'input_request'; prompt: string; password: boolean }
  | { t: 'reply'; status: 'ok' | 'error' | 'aborted'; executionCount?: number | undefined }
  | { t: 'ignored' };

/**
 * Reads one kernel message as an event, building nbformat outputs from the fields Jupyter
 * documents; unknown types are ignored.
 */
export function kernelEvent(message: KernelMessage): KernelEvent {
  const { content } = message;
  switch (message.header.msg_type) {
    case 'status': {
      const state = content.execution_state;
      return state === 'busy' ||
        state === 'idle' ||
        state === 'starting' ||
        state === 'restarting' ||
        state === 'dead'
        ? { t: 'status', state }
        : { t: 'ignored' };
    }
    case 'stream':
      return {
        t: 'output',
        output: {
          output_type: 'stream',
          name: content.name === 'stderr' ? 'stderr' : 'stdout',
          text: text(content.text),
        },
      };
    case 'display_data':
      return {
        t: 'output',
        output: {
          output_type: 'display_data',
          data: record(content.data),
          metadata: record(content.metadata),
        },
      };
    case 'execute_result':
      return {
        t: 'output',
        output: {
          output_type: 'execute_result',
          execution_count: Number.isInteger(content.execution_count)
            ? (content.execution_count as number)
            : null,
          data: record(content.data),
          metadata: record(content.metadata),
        },
      };
    case 'error':
      return {
        t: 'output',
        output: {
          output_type: 'error',
          ename: text(content.ename),
          evalue: text(content.evalue),
          traceback: Array.isArray(content.traceback)
            ? content.traceback.filter((line): line is string => typeof line === 'string')
            : [],
        },
      };
    case 'clear_output':
      return { t: 'clear_output' };
    case 'input_request':
      return { t: 'input_request', prompt: text(content.prompt), password: !!content.password };
    case 'execute_reply': {
      const status = content.status;
      const executionCount = Number.isInteger(content.execution_count)
        ? (content.execution_count as number)
        : undefined;
      return {
        t: 'reply',
        status: status === 'ok' ? 'ok' : status === 'aborted' ? 'aborted' : 'error',
        executionCount,
      };
    }
    default:
      return { t: 'ignored' };
  }
}

// ── Execution states (§10.6) ───────────────────────────────────────────────────────────────

export type ExecutionEvent =
  /** `status: busy` with this execution as parent. */
  | { t: 'busy' }
  /** `execute_reply`. */
  | { t: 'reply'; status: 'ok' | 'error' | 'aborted' }
  /** Writing the `execute_request` failed: it may or may not have reached the kernel. */
  | { t: 'write_failed' }
  /** The link or the kernel channel dropped, or the relay process started. */
  | { t: 'link_lost' }
  /** After the link returned, Jupyter says the kernel is busy; the channel was reopened. */
  | { t: 'reconnected_busy' }
  /** After the link returned, the kernel was idle and the replay drained without a reply. */
  | { t: 'drained' }
  /** The kernel was restarted, replaced or shut down. */
  | { t: 'restart' }
  /** Jupyter no longer knows the kernel. */
  | { t: 'kernel_lost' };

export const FINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  'ok',
  'error',
  'aborted',
  'incomplete',
];
export const isFinalExecution = (state: ExecutionState) => FINAL_EXECUTION_STATES.includes(state);

/** The state `event` moves an execution in `state` to, or null when it does not apply. */
export function nextExecutionState(
  state: ExecutionState,
  event: ExecutionEvent,
): ExecutionState | null {
  if (isFinalExecution(state)) return null;
  switch (event.t) {
    case 'busy':
      return state === 'sent' || state === 'unconfirmed' ? 'running' : null;
    case 'reply':
      return event.status;
    case 'write_failed':
      return state === 'sent' ? 'unconfirmed' : null;
    case 'link_lost':
      return state === 'sent' || state === 'running' ? 'unconfirmed' : null;
    case 'reconnected_busy':
      return state === 'unconfirmed' ? 'running' : null;
    case 'drained':
      return 'incomplete';
    case 'restart':
      return 'aborted';
    case 'kernel_lost':
      return 'incomplete';
  }
}

// ── Kernel states ──────────────────────────────────────────────────────────────────────────

export type KernelStateEvent =
  /** Jupyter's `execution_state`, from the start answer, a status message or a state query. */
  | { t: 'reported'; state: 'starting' | 'idle' | 'busy' | 'restarting' | 'dead' }
  /** An execution waits on an `input_request`. */
  | { t: 'input_request' }
  /** The prompt was answered. */
  | { t: 'input_replied' }
  /** A restart was asked for. */
  | { t: 'restart' }
  /** The channel or the link dropped: the relay cannot hear the kernel. */
  | { t: 'lost' };

/** The kernel state `event` moves `state` to (always defined: the kernel's word wins). */
export function nextKernelState(state: KernelState, event: KernelStateEvent): KernelState {
  switch (event.t) {
    case 'reported':
      // A prompt stays open while the kernel reports busy; idle or anything else ends it.
      return state === 'waiting_for_input' && event.state === 'busy' ? state : event.state;
    case 'input_request':
      return state === 'dead' || state === 'unknown' ? state : 'waiting_for_input';
    case 'input_replied':
      return state === 'waiting_for_input' ? 'busy' : state;
    case 'restart':
      return 'restarting';
    case 'lost':
      return 'unknown';
  }
}

// ── The in-memory map ──────────────────────────────────────────────────────────────────────

/** One open execution as the relay holds it, keyed by its `msg_id`. */
export interface BoundExecution {
  id: string;
  msgId: string;
  ref: string;
  cellId: string;
  seq: number;
  kernelId: string;
  generation: number;
  state: ExecutionState;
  executionCount?: number | undefined;
  outputsIncomplete: boolean;
}

/** Why a kernel message was dropped (counted, never shown). */
export type DropReason = 'unparsable' | 'unknown_parent' | 'other_kernel' | 'old_generation';

/**
 * The open executions of one session's kernel, rebuilt from the `sent`, `running` and
 * `unconfirmed` rows, and the matching rule of §10.6.
 */
export class ExecutionMap {
  private readonly byMsgId = new Map<string, BoundExecution>();

  constructor(rows: BoundExecution[] = []) {
    for (const row of rows) this.add(row);
  }

  add(execution: BoundExecution): void {
    this.byMsgId.set(execution.msgId, execution);
  }

  remove(msgId: string): void {
    this.byMsgId.delete(msgId);
  }

  get(msgId: string): BoundExecution | undefined {
    return this.byMsgId.get(msgId);
  }

  byId(id: string): BoundExecution | undefined {
    for (const execution of this.byMsgId.values()) if (execution.id === id) return execution;
    return undefined;
  }

  all(): BoundExecution[] {
    return [...this.byMsgId.values()].sort((a, b) => a.seq - b.seq);
  }

  clear(): void {
    this.byMsgId.clear();
  }

  /**
   * The execution a message from the channel of `channelKernel` belongs to, given the session's
   * current kernel and generation; otherwise why it is dropped.
   */
  match(
    parent: string | undefined,
    channelKernel: string,
    current: { kernelId: string | null; generation: number },
  ): { ok: true; execution: BoundExecution } | { ok: false; reason: DropReason } {
    if (channelKernel !== current.kernelId) return { ok: false, reason: 'other_kernel' };
    const execution = parent ? this.byMsgId.get(parent) : undefined;
    if (!execution) return { ok: false, reason: 'unknown_parent' };
    if (execution.kernelId !== channelKernel) return { ok: false, reason: 'other_kernel' };
    if (execution.generation !== current.generation) return { ok: false, reason: 'old_generation' };
    return { ok: true, execution };
  }
}
