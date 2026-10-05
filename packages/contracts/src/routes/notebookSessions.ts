import { z } from 'zod';
import { LinkEnvironment, LinkKernelspec, LinkLease, LinkRuntime } from '../connector';
import { classArchived, defineRoute, errorBody } from '../define';
import { exampleIds } from '../examples';
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
