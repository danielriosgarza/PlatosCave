import { z } from 'zod';
import {
  ConnectorName,
  LinkConfirmation,
  LinkEnvironment,
  LinkKernelspec,
  LinkRuntime,
  LinkStage,
  LinkTarget,
} from '../connector';
import { defineRoute, errorBody } from '../define';
import { exampleIds } from '../examples';

/**
 * Saved connections and Test connection (docs/design/connector.md §2, §5, §10.3). A connection
 * is the signed-in person's own, secret-free reference to a target, kept across classes; a
 * preview principal is refused with 403 and another person's connection is the shared 404, for
 * the person's own instructors too (A33).
 */

const datetime = z.iso.datetime({ offset: true });
const connectionParams = z.object({ connectionId: z.uuid() });
const exampleConnection = { connectionId: exampleIds.aa };
const preview = z.object({ error: z.literal('forbidden') });

const [localTarget, sshTarget] = LinkTarget.options;
/**
 * The target a person saves: `local` or `ssh` as in §4.4, without `hostKeys`, which the server
 * fills from the keys the person trusted. `managed` targets come from class templates (P3-10).
 */
export const ConnectionTarget = z.discriminatedUnion('kind', [
  localTarget,
  sshTarget.omit({ hostKeys: true }),
]);
export type ConnectionTarget = z.infer<typeof ConnectionTarget>;

export const TrustedHostKey = z.object({
  host: z.string(),
  port: z.number().int(),
  sha256: z.string(),
  confirmedAt: datetime,
});

export const ConnectionView = z.object({
  id: z.uuid(),
  name: z.string(),
  connectorId: z.uuid(),
  target: ConnectionTarget,
  runtime: LinkRuntime,
  templateId: z.uuid().nullable(),
  /** Host keys the person confirmed for this connection's target and jump host (§5.2). */
  trustedHostKeys: z.array(TrustedHostKey),
  createdAt: datetime,
  updatedAt: datetime,
  archivedAt: datetime.nullable(),
});
export type ConnectionView = z.infer<typeof ConnectionView>;

/**
 * 400 for a target Parallax refuses before anything is sent: `invalid_target` breaks a rule of
 * §4.4 (`rules` names them), `network_scope_denied` is a loopback, private or shared address the
 * connector's reported scope does not cover (§8).
 */
export const targetRefused = z.object({
  error: z.literal('target_not_allowed'),
  code: z.enum(['invalid_target', 'network_scope_denied']),
  rules: z.array(z.number().int()).optional(),
});

const exampleTarget = {
  kind: 'ssh' as const,
  host: 'login.cluster.example.org',
  port: 22,
  user: 'sam',
  auth: { method: 'key' as const, keyPath: '~/.ssh/id_ed25519' },
  workspace: '/home/sam/parallax',
};

/** The person's unarchived connections, newest first. */
export const listConnections = defineRoute({
  method: 'GET',
  path: '/api/me/connections',
  scope: { kind: 'user' },
  summary: "List the signed-in person's saved connections",
  response: z.array(ConnectionView),
  errors: { 403: preview },
  examples: {},
});

/**
 * Saves a connection (§2, step 2). The connector must be the caller's and active (else 404 or
 * 409 `connector_not_active`); a template must be one of a class the caller belongs to (404).
 * The schema has no field for a secret. 409 `name_taken` when another unarchived connection of
 * the person has the name.
 */
export const createConnection = defineRoute({
  method: 'POST',
  path: '/api/me/connections',
  scope: { kind: 'user' },
  summary: 'Save a connection',
  status: 201,
  body: z.strictObject({
    name: ConnectorName,
    connectorId: z.uuid(),
    target: ConnectionTarget,
    runtime: LinkRuntime,
    templateId: z.uuid().optional(),
  }),
  response: ConnectionView,
  errors: {
    400: targetRefused,
    403: preview,
    409: z.object({ error: z.enum(['connector_not_active', 'name_taken']) }),
  },
  examples: {
    body: {
      name: 'Lab workstation',
      connectorId: exampleIds.bb,
      target: exampleTarget,
      runtime: { mode: 'start', kernelName: 'python3' },
    },
  },
});

export const getConnection = defineRoute({
  method: 'GET',
  path: '/api/me/connections/:connectionId',
  scope: { kind: 'user' },
  summary: 'Read a saved connection',
  params: connectionParams,
  response: ConnectionView,
  errors: { 403: preview },
  examples: { params: exampleConnection },
});

/**
 * Renames a connection or changes its target or runtime. A change of host, port or jump host
 * drops the trusted host keys the new target no longer names (§10.3).
 */
export const updateConnection = defineRoute({
  method: 'PATCH',
  path: '/api/me/connections/:connectionId',
  scope: { kind: 'user' },
  summary: 'Change a saved connection',
  params: connectionParams,
  body: z
    .strictObject({
      name: ConnectorName.optional(),
      target: ConnectionTarget.optional(),
      runtime: LinkRuntime.optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
      message: 'nothing to change',
    }),
  response: ConnectionView,
  errors: {
    400: targetRefused,
    403: preview,
    409: z.object({ error: z.literal('name_taken') }),
  },
  examples: { params: exampleConnection, body: { name: 'Cluster login node' } },
});

/** Archives a connection; 409 `in_use` (with the session's id) while a session on it is open. */
export const archiveConnection = defineRoute({
  method: 'DELETE',
  path: '/api/me/connections/:connectionId',
  scope: { kind: 'user' },
  summary: 'Archive a saved connection',
  params: connectionParams,
  response: ConnectionView,
  errors: {
    403: preview,
    409: z.object({ error: z.literal('in_use'), sessionId: z.uuid() }),
  },
  examples: { params: exampleConnection },
});

/**
 * Starts Test connection (§2, step 3; §5.1): `202 { testId }`, then poll the result. A
 * confirmation with `replacing` replaces a remembered host key: it needs a recent sign-in (401
 * `recent_auth_required`) and `replacing` must equal the `expected` key of this connection's
 * latest `host_key_changed` result for that host and port (409 `replacing_mismatch`). 409
 * `connector_offline` when the connector holds no link; 429 beyond 6 tests a minute.
 */
export const startConnectionTest = defineRoute({
  method: 'POST',
  path: '/api/me/connections/:connectionId/test',
  scope: { kind: 'user' },
  summary: 'Test a saved connection',
  status: 202,
  params: connectionParams,
  body: z.strictObject({ confirmations: z.array(LinkConfirmation).max(2).optional() }),
  response: z.object({ testId: z.uuid() }),
  errors: {
    400: targetRefused,
    403: preview,
    409: z.object({ error: z.enum(['connector_offline', 'replacing_mismatch']) }),
    429: errorBody,
  },
  examples: {
    params: exampleConnection,
    body: {
      confirmations: [
        {
          host: 'login.cluster.example.org',
          port: 22,
          sha256: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
        },
      ],
    },
  },
});

export const ConnectionTestView = z.object({
  testId: z.uuid(),
  state: z.enum(['running', 'done']),
  /**
   * The finished stages in order and, while the connector waits for an answer in its own
   * terminal, the `running` `ssh_auth` stage last.
   */
  stages: z.array(LinkStage),
  outcome: z.enum(['ready', 'ready_to_start', 'needs_action', 'failed']).optional(),
  /**
   * Why a test ended without the connector's result, a catalogue code: `test_timeout` after
   * 300 s, `connector_offline` when the link closed, or the code of a refused request
   * (`invalid_target`, `unsupported_target`, `limit_exceeded`, …). The outcome is then `failed`.
   */
  code: z.string().optional(),
  kernelspecs: z.array(LinkKernelspec).optional(),
  attachable: z
    .array(
      z.object({ port: z.number().int(), pid: z.number().int().optional(), rootDir: z.string() }),
    )
    .optional(),
  jupyterVersion: z.string().optional(),
  environment: LinkEnvironment.optional(),
});
export type ConnectionTestView = z.infer<typeof ConnectionTestView>;

/** A test run, held 10 minutes; the web app polls it every second. */
export const getConnectionTest = defineRoute({
  method: 'GET',
  path: '/api/me/connections/:connectionId/tests/:testId',
  scope: { kind: 'user' },
  summary: 'Read the progress or result of a connection test',
  params: z.object({ connectionId: z.uuid(), testId: z.uuid() }),
  response: ConnectionTestView,
  errors: { 403: preview },
  examples: { params: { connectionId: exampleIds.aa, testId: exampleIds.bb } },
});
