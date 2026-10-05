import { z } from 'zod';
import { NOTEBOOK_CELL_ID } from './notebook';

/**
 * The browser channel of a notebook session (docs/design/connector.md §10.5): JSON text frames
 * over `GET /api/classes/:classId/notebook-sessions/:sessionId/channels`, `v: 1` on each. The
 * browser never names a Jupyter path, kernel id or message id: it sends cells and prompts, and
 * the relay binds each execution to the session's current kernel and generation (§10.6).
 */

/** §10.5: the code of one `execute` is at most 1 MiB (UTF-8). */
export const MAX_EXECUTE_CODE_BYTES = 1024 * 1024;
/**
 * The largest frame the channel accepts from a browser (a larger one is closed with 1009). An
 * `execute` of ordinary code at its 1 MiB limit fits; code made mostly of characters JSON escapes
 * (control characters) may not.
 */
export const MAX_CHANNEL_FRAME_BYTES = 2 * 1024 * 1024;
/** The answer to an `input_request` (a typed line) is at most 64 KiB. */
export const MAX_INPUT_REPLY_BYTES = 64 * 1024;

const v = z.literal(1);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const msg = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.strictObject({ v, t: z.literal(t), ...shape });

// ── browser → server ───────────────────────────────────────────────────────────────────────

/** First message; `resume` asks for the output events after a position in an earlier epoch. */
export const ChannelHello = msg('hello', {
  resume: z.strictObject({ epoch: z.uuid(), afterEventSeq: z.number().int().min(0) }).optional(),
});

/** Runs one cell. `ref` is the browser's idempotency key: resending it never runs it again. */
export const ChannelExecute = msg('execute', {
  ref: z.uuid(),
  cellId: z.string().regex(NOTEBOOK_CELL_ID),
  workingCopyRevision: z.number().int().min(1).optional(),
  code: z.string().refine((code) => utf8Bytes(code) <= MAX_EXECUTE_CODE_BYTES, {
    message: 'code is at most 1 MiB',
  }),
});

/** Answers the prompt an execution is waiting on. */
export const ChannelInputReply = msg('input_reply', {
  executionId: z.uuid(),
  value: z.string().refine((value) => utf8Bytes(value) <= MAX_INPUT_REPLY_BYTES, {
    message: 'the reply is at most 64 KiB',
  }),
});

/** Interrupts the running cell of the session's kernel. */
export const ChannelInterrupt = msg('interrupt', {});

export const ChannelClientMessage = z.discriminatedUnion('t', [
  ChannelHello,
  ChannelExecute,
  ChannelInputReply,
  ChannelInterrupt,
]);
export type ChannelClientMessage = z.infer<typeof ChannelClientMessage>;
export const CHANNEL_CLIENT_TYPES = new Set(['hello', 'execute', 'input_reply', 'interrupt']);

// ── server → browser ───────────────────────────────────────────────────────────────────────

export const ChannelSessionState = z.enum([
  'starting',
  'ready',
  'disconnected',
  'unconfirmed',
  'stopping',
  'stopped',
  'failed',
]);

/** The kernel as the relay last knew it; `unknown` while the connector cannot be heard. */
export const KernelState = z.enum([
  'starting',
  'idle',
  'busy',
  'waiting_for_input',
  'restarting',
  'dead',
  'unknown',
]);
export type KernelState = z.infer<typeof KernelState>;

/**
 * One execution's state (§10.6). `unconfirmed`: it may or may not have reached the kernel;
 * `incomplete`: its outcome or some output is unknown and the person decides whether to run it
 * again; `aborted`: the kernel was restarted or replaced before it finished.
 */
export const ExecutionState = z.enum([
  'sent',
  'running',
  'ok',
  'error',
  'aborted',
  'incomplete',
  'unconfirmed',
]);
export type ExecutionState = z.infer<typeof ExecutionState>;

export const KernelView = z.object({
  id: z.uuid(),
  name: z.string(),
  state: KernelState,
  /** Increases on every restart and new kernel; outputs of an older one are the previous kernel's. */
  generation: z.number().int().min(0),
});
export type KernelView = z.infer<typeof KernelView>;

/** An nbformat 4 output object, as the kernel produced it; untrusted (rendered by P2-13's sanitiser). */
export const LiveOutput = z.discriminatedUnion('output_type', [
  z.object({
    output_type: z.literal('stream'),
    name: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  z.object({
    output_type: z.literal('display_data'),
    data: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
  }),
  z.object({
    output_type: z.literal('execute_result'),
    execution_count: z.number().int().nullable(),
    data: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
  }),
  z.object({
    output_type: z.literal('error'),
    ename: z.string(),
    evalue: z.string(),
    traceback: z.array(z.string()),
  }),
]);
export type LiveOutput = z.infer<typeof LiveOutput>;

export const ChannelReady = msg('ready', {
  /** Changes with every relay process life and session; another epoch means the position is lost. */
  epoch: z.uuid(),
  /** The last output event's sequence number in this epoch (0 before any). */
  eventSeq: z.number().int().min(0),
  session: z.object({
    state: ChannelSessionState,
    cause: z.string().nullable(),
    owned: z.boolean(),
    lease: z.object({ idleTimeoutMin: z.number().int(), gracePeriodMin: z.number().int() }),
  }),
  kernel: KernelView.nullable(),
});

export const ChannelExecution = msg('execution', {
  executionId: z.uuid(),
  ref: z.uuid(),
  cellId: z.string(),
  seq: z.number().int().min(1),
  state: ExecutionState,
  executionCount: z.number().int().optional(),
  outputsIncomplete: z.boolean(),
  generation: z.number().int().min(0),
});

export const ChannelOutput = msg('output', {
  executionId: z.uuid(),
  eventSeq: z.number().int().min(1),
  generation: z.number().int().min(0),
  kind: z.enum(['output', 'clear_output', 'input_request']),
  /** Present when `kind` is `output`. */
  output: LiveOutput.optional(),
  /** Present when `kind` is `input_request`: the prompt and whether the answer is hidden. */
  input: z.object({ prompt: z.string(), password: z.boolean() }).optional(),
  /** Earlier output of this execution was dropped from the relay's buffer (§10.6). */
  truncated: z.literal(true).optional(),
});

export const ChannelKernelState = msg('kernel_state', {
  state: KernelState,
  generation: z.number().int().min(0),
});

export const ChannelSessionStateMessage = msg('session_state', {
  state: ChannelSessionState,
  cause: z.string().nullable().optional(),
  leaseExpiresAt: z.iso.datetime({ offset: true }).optional(),
});

export const CHANNEL_ERROR_CODES = [
  'invalid_message',
  'not_ready',
  'rate_limited',
  'unknown_execution',
  'not_waiting_for_input',
  'connector_offline',
  'internal',
] as const;

export const ChannelError = msg('error', {
  code: z.enum(CHANNEL_ERROR_CODES),
  detail: z.string().max(512).optional(),
  /** The `ref` of the `execute` this error answers, when it answers one. */
  ref: z.uuid().optional(),
});

export const ChannelServerMessage = z.discriminatedUnion('t', [
  ChannelReady,
  ChannelExecution,
  ChannelOutput,
  ChannelKernelState,
  ChannelSessionStateMessage,
  ChannelError,
]);
export type ChannelServerMessage = z.infer<typeof ChannelServerMessage>;
export type ChannelServerMessageInput = z.input<typeof ChannelServerMessage>;

/**
 * WebSocket close codes the relay uses on the channel. 4403: the caller's access to the class or
 * session is gone (re-validation, §10.1); 4410: the session ended.
 */
export const CHANNEL_CLOSE = {
  scope_lost: 4403,
  session_closed: 4410,
  protocol_error: 4400,
} as const;
