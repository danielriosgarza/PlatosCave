import { z } from 'zod';
import { LinkEnvironment, LinkKernelspec, LinkLease, LinkRuntime } from '../connector';
import { classArchived, defineRoute, errorBody } from '../define';
import { exampleIds } from '../examples';
import { ExecutionState, KernelView } from '../notebookChannel';
import { targetRefused } from './connections';

/**
 * Notebook sessions of one class (docs/design/connector.md §2, §9, §10.3, §10.7): a Jupyter
 * server opened through the caller's own connector for one notebook. Every route is class-scoped
 * and reads only the caller's own sessions: anyone else's, the class instructor's included, is
 * the shared 404 (A33).
 */

const datetime = z.iso.datetime({ offset: true });
const classParams = z.object({ classId: z.uuid() });
const sessionParams = z.object({ classId: z.uuid(), sessionId: z.uuid() });
const exampleSession = { classId: exampleIds.zero, sessionId: exampleIds.cc };

export const SessionState = z.enum([
  'starting',
  'ready',
  'disconnected',
  'unconfirmed',
  'stopping',
  'stopped',
  'failed',
]);

export const SessionView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  connectorId: z.uuid(),
  resourceRevisionId: z.uuid(),
  /**
   * The server's view (§10.7). `unconfirmed`: Parallax cannot currently hear from the connector
   * and does not know whether the process runs. `stopped` with cause `abandoned` says nothing
   * about the process either.
   */
  state: SessionState,
  /** A loss cause of §5.5, or the catalogue code a session failed with. */
  cause: z.string().nullable(),
  /** Whether the connector started the process, so Stop is possible (A32). */
  owned: z.boolean(),
  runtime: z.object({
    mode: z.enum(['start', 'attach']),
    kernelName: z.string().optional(),
    kernelspecs: z.array(LinkKernelspec).optional(),
  }),
  environment: LinkEnvironment.nullable(),
  jupyterVersion: z.string().nullable(),
  lease: LinkLease,
  leaseExpiresAt: datetime.nullable(),
  kernelName: z.string().nullable(),
  lastHeartbeatAt: datetime.nullable(),
  createdAt: datetime,
  stoppedAt: datetime.nullable(),
});
export type SessionView = z.infer<typeof SessionView>;

/** The caller's sessions in this class, newest first (at most 50). */
export const listNotebookSessions = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions',
  scope: { kind: 'class', role: 'any' },
  summary: "List the caller's notebook sessions in a class",
  params: classParams,
  response: z.array(SessionView),
  examples: { params: { classId: exampleIds.zero } },
});

/**
 * Connect (§2, step 4): opens a session for a notebook revision of the class's release on one of
 * the caller's saved connections, `202 { sessionId, state: 'starting' }`. 404 for a connection
 * or revision the caller cannot use; 409 `connector_offline`; 409 `session_exists` with the open
 * session's id; 409 `wrong_class` for a connection made from another class's template; 400 for a
 * target the connector's scope no longer covers; 429 beyond 6 a minute.
 */
export const openNotebookSession = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions',
  scope: { kind: 'class', role: 'any' },
  summary: 'Open a notebook session through a saved connection',
  status: 202,
  params: classParams,
  body: z.strictObject({
    connectionId: z.uuid(),
    revisionId: z.uuid(),
    /** Defaults to the connection's runtime; Connect may choose another kernel or attach port. */
    runtime: LinkRuntime.optional(),
    /** Defaults to 30 minutes idle and 5 minutes of grace (§9). */
    lease: LinkLease.optional(),
  }),
  response: z.object({ sessionId: z.uuid(), state: SessionState }),
  errors: {
    400: targetRefused,
    409: z.union([
      z.object({ error: z.enum(['connector_offline', 'wrong_class']) }),
      z.object({ error: z.literal('session_exists'), sessionId: z.uuid() }),
      classArchived,
    ]),
    429: errorBody,
  },
  examples: {
    params: { classId: exampleIds.zero },
    body: { connectionId: exampleIds.aa, revisionId: exampleIds.bb },
  },
});

export const getNotebookSession = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read one of the caller’s notebook sessions',
  params: sessionParams,
  response: SessionView,
  examples: { params: exampleSession },
});

/**
 * Disconnect (`stop: false`) or Stop (`stop: true`), §2 steps 8 and 10. A stop moves the session
 * to `stopping`; it reads `stopped` only once the connector confirms. 409 `not_owned` for an
 * attached session (A32), `connector_offline`, or `not_open` for a session that has ended.
 */
export const closeNotebookSession = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/close',
  scope: { kind: 'class', role: 'any' },
  summary: 'Disconnect from or stop a notebook session',
  status: 202,
  params: sessionParams,
  body: z.strictObject({ stop: z.boolean() }),
  response: SessionView,
  errors: {
    409: z.object({ error: z.enum(['not_owned', 'connector_offline', 'not_open']) }),
  },
  examples: { params: exampleSession, body: { stop: false } },
});

/**
 * Forget (A36): gives up on a session that is `disconnected`, `unconfirmed` or `stopping`. It
 * becomes `stopped` with cause `abandoned`; nothing is sent to the connector, and Parallax does
 * not know whether the process still runs. 409 `not_forgettable` in any other state.
 */
export const forgetNotebookSession = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/forget',
  scope: { kind: 'class', role: 'any' },
  summary: 'Give up on a notebook session that cannot be reached',
  params: sessionParams,
  response: SessionView,
  errors: { 409: z.object({ error: z.literal('not_forgettable') }) },
  examples: { params: exampleSession },
});

// ── Kernel and executions (P3-06a, §7, §10.6) ──────────────────────────────────────────────

/**
 * 409 for a kernel operation the session cannot take now: `not_ready` (the session is not
 * `ready` or its kernel channel is down), `kernel_exists` (start while a kernel runs: restart it
 * or delete it first), `no_kernel`, `connector_offline`, or `kernel_failed` with the catalogue
 * code or Jupyter status the connector answered.
 */
export const kernelRefused = z.object({
  error: z.enum(['not_ready', 'kernel_exists', 'no_kernel', 'connector_offline', 'kernel_failed']),
  code: z.string().optional(),
});

export const SessionKernel = z.object({ kernel: KernelView.nullable() });

/**
 * Starts a kernel of the chosen kernelspec in a `ready` session and opens its one kernel channel
 * (§7). A kernel lost while the connector was away (cause `kernel_lost`) is replaced only this
 * way: its variables are gone.
 */
export const startSessionKernel = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/kernel',
  scope: { kind: 'class', role: 'any' },
  summary: 'Start the kernel of a notebook session',
  status: 201,
  params: sessionParams,
  body: z.strictObject({ kernelName: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/) }),
  response: SessionKernel,
  errors: { 409: kernelRefused },
  examples: { params: exampleSession, body: { kernelName: 'python3' } },
});

/** The session's kernel as the relay knows it, or null. */
export const getSessionKernel = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/kernel',
  scope: { kind: 'class', role: 'any' },
  summary: 'Read the kernel of a notebook session',
  params: sessionParams,
  response: SessionKernel,
  examples: { params: exampleSession },
});

/** Shuts the kernel down; its unfinished executions become `aborted`. */
export const deleteSessionKernel = defineRoute({
  method: 'DELETE',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/kernel',
  scope: { kind: 'class', role: 'any' },
  summary: 'Shut down the kernel of a notebook session',
  params: sessionParams,
  response: SessionKernel,
  errors: { 409: kernelRefused },
  examples: { params: exampleSession },
});

/** Asks the kernel to stop its current operation. */
export const interruptSessionKernel = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/kernel/interrupt',
  scope: { kind: 'class', role: 'any' },
  summary: 'Interrupt the kernel of a notebook session',
  params: sessionParams,
  response: SessionKernel,
  errors: { 409: kernelRefused },
  examples: { params: exampleSession },
});

/**
 * Restarts the kernel (§10.6): its generation increases, unfinished executions become `aborted`
 * and nothing is run again; outputs already shown belong to the previous generation.
 */
export const restartSessionKernel = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/kernel/restart',
  scope: { kind: 'class', role: 'any' },
  summary: 'Restart the kernel of a notebook session',
  params: sessionParams,
  response: SessionKernel,
  errors: { 409: kernelRefused },
  examples: { params: exampleSession },
});

export const ExecutionView = z.object({
  id: z.uuid(),
  ref: z.uuid(),
  cellId: z.string(),
  seq: z.number().int().min(1),
  state: ExecutionState,
  executionCount: z.number().int().nullable(),
  outputsIncomplete: z.boolean(),
  generation: z.number().int().min(0),
  workingCopyRevision: z.number().int().nullable(),
  sentAt: datetime.nullable(),
  finishedAt: datetime.nullable(),
});
export type ExecutionView = z.infer<typeof ExecutionView>;

/** The session's executions after `afterSeq`, in order, at most 500: how a reload reconciles. */
export const listSessionExecutions = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/executions',
  scope: { kind: 'class', role: 'any' },
  summary: 'List the executions of a notebook session',
  params: sessionParams,
  query: z.object({ afterSeq: z.coerce.number().int().min(0).default(0) }),
  response: z.object({ executions: z.array(ExecutionView) }),
  examples: { params: exampleSession, query: { afterSeq: 0 } },
});

/**
 * The browser channel (§10.5): a WebSocket of `notebookChannel.ts` messages. Before the upgrade
 * the scope is resolved (a non-member, or anyone but the session's owner, gets the shared 404),
 * and an `Origin` other than the app's is 403 (cross-site WebSocket hijacking).
 */
export const notebookSessionChannel = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/notebook-sessions/:sessionId/channels',
  scope: { kind: 'class', role: 'any' },
  summary: 'Notebook session channel (WebSocket)',
  websocket: true,
  params: sessionParams,
  response: z.never(),
  errors: { 403: errorBody },
  examples: { params: exampleSession },
});
