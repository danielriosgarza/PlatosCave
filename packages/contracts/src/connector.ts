import { z } from 'zod';

/**
 * Connector protocol v1: the zod mirror of `connector/protocol/v1/pairing.schema.json` (the
 * bodies of the public endpoints under `/api/connector/v1`, docs/design/connector.md §3, §4.2)
 * and of `link.schema.json` (the link's control messages, §4.3), the semantic target rules of
 * §4.4 (`validateTarget`), the error catalogue's keys (`errors.json`, §5.4) and the close codes
 * of §4.6. `connector.test.ts` holds it to the fixtures under `connector/protocol/v1/examples/`.
 */

/** Lower-case UUID. */
export const ConnectorUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** 32 bytes, base64url without padding (an Ed25519 public key). */
export const B64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** 64 bytes, base64url without padding (an Ed25519 signature). */
export const B64url64 = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
/** `SHA256:` and the unpadded base64 of the SHA-256 of the raw public key (§3). */
export const ConnectorFingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
export const Semver = z
  .string()
  .max(32)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/);
export const UnixSeconds = z.number().int().min(0).max(4102444800);
/** RFC 3339, UTC, with the Z suffix. */
export const UtcTimestamp = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/);
export const ConnectorOs = z.enum(['linux', 'darwin', 'windows']);
export const ConnectorArch = z.enum(['amd64', 'arm64']);

/** No C0 control character and no DEL, as the schema's `^[^\x00-\x1f\x7f]+$`. */
const hasNoControl = (s: string) =>
  [...s].every((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });

/** A device name: 1 to 60 characters without control characters. */
export const ConnectorName = z
  .string()
  .min(1)
  .max(60)
  .refine(hasNoControl, { message: 'control characters are not allowed' });

/** Crockford base 32 without `I L O U`: what a normalised pairing code may hold. */
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Body of `POST /api/connector/v1/pair`. */
export const PairRequest = z.strictObject({
  code: z.string().regex(PAIRING_CODE_PATTERN),
  publicKey: B64url32,
  name: ConnectorName,
  os: ConnectorOs,
  arch: ConnectorArch,
  version: Semver,
});
export type PairRequest = z.infer<typeof PairRequest>;

/** Answer 201 of `POST /api/connector/v1/pair`. */
export const PairResponse = z.strictObject({
  connectorId: ConnectorUuid,
  fingerprint: ConnectorFingerprint,
  status: z.literal('pending'),
  pollAfterSeconds: z.number().int().min(1).max(60),
  approveBy: UtcTimestamp,
});
export type PairResponse = z.infer<typeof PairResponse>;

/** Body of `POST /api/connector/v1/pair/poll` and `POST /api/connector/v1/unpair`. */
export const SignedRequest = z.strictObject({
  connectorId: ConnectorUuid,
  ts: UnixSeconds,
  sig: B64url64,
});
export type SignedRequest = z.infer<typeof SignedRequest>;

export const PollResponse = z.strictObject({
  status: z.enum(['pending', 'active', 'rejected', 'expired']),
  pollAfterSeconds: z.number().int().min(1).max(60).optional(),
});
export type PollResponse = z.infer<typeof PollResponse>;

/** Every refusal of the pairing endpoints. */
export const ErrorBody = z.strictObject({ error: z.string().max(200) });
export type ErrorBody = z.infer<typeof ErrorBody>;

/** The pairing definitions by name, as the `pairing-<Def>` fixture prefix selects them. */
export const PAIRING_DEFS = {
  PairRequest,
  PairResponse,
  SignedRequest,
  PollResponse,
  ErrorBody,
} as const;

/* ------------------------------------------------------------------------------------------ */
/* Link half: `link.schema.json` (docs/design/connector.md §4).                                */
/* ------------------------------------------------------------------------------------------ */

/** The WebSocket subprotocol of the link; it names the protocol's major version (§4.6). */
export const LINK_SUBPROTOCOL = 'parallax.connector.v1';

/**
 * Close codes of the link (§4.6) by reason string. The reason travels as the close frame's
 * reason, so the connector can tell `pending`, `approval_expired` and `revoked` apart under the
 * shared 4403.
 */
export const LINK_CLOSE = {
  protocol_error: 4400,
  bad_signature: 4401,
  clock_skew: 4401,
  pending: 4403,
  approval_expired: 4403,
  revoked: 4403,
  mode_mismatch: 4403,
  heartbeat_timeout: 4408,
  replaced: 4409,
  upgrade_required: 4426,
  rate_limited: 4429,
  server_error: 4500,
} as const;
export type LinkCloseReason = keyof typeof LINK_CLOSE;

/** Every `code` of the catalogue: the keys of `errors.json#/codes` (§5.4). */
export const ERROR_CODES = [
  'agent_no_identity',
  'agent_unavailable',
  'attach_none_found',
  'attach_not_loopback',
  'attach_port_unreachable',
  'auth_method_unsupported',
  'auth_rejected',
  'body_too_large',
  'busy',
  'connection_refused',
  'connection_timeout',
  'environment_invalid',
  'forwarding_denied',
  'host_key_changed',
  'host_key_unknown',
  'host_key_untrusted_managed',
  'host_unresolved',
  'internal',
  'invalid_message',
  'invalid_target',
  'jupyter_incompatible',
  'jupyter_missing',
  'jupyter_start_failed',
  'jupyter_start_timeout',
  'kernel_start_failed',
  'kernelspec_not_found',
  'key_file_unreadable',
  'key_passphrase_required',
  'key_passphrase_wrong',
  'limit_exceeded',
  'mfa_failed',
  'mfa_requires_terminal',
  'network_scope_denied',
  'no_kernelspec',
  'not_owned',
  'not_ready',
  'notebook_service_unreachable',
  'path_not_allowed',
  'rate_limited',
  'remote_exec_denied',
  'shell_unsupported',
  'stream_cancelled',
  'test_timeout',
  'token_rejected',
  'token_unavailable',
  'tunnel_unavailable',
  'unknown_session',
  'unknown_stream',
  'unsupported_message',
  'unsupported_target',
  'workspace_missing',
  'workspace_not_directory',
  'workspace_not_writable',
  'workspace_outside_root',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The spec §14 cause words a code maps to: the keys of `errors.json#/causes`. */
export const CAUSES = [
  'authentication',
  'host_key',
  'kernel',
  'policy',
  'protocol',
  'reachability',
  'runtime',
  'tunnel',
  'workspace',
] as const;
export type Cause = (typeof CAUSES)[number];

/** Why a session was lost or stopped (§5.5): the keys of `errors.json#/loss`. */
export const LOSS_CAUSES = [
  'abandoned',
  'allocation_expired',
  'connector_exit',
  'connector_offline',
  'connector_restarted',
  'connector_revoked',
  'host_unreachable',
  'kernel_lost',
  'lease_grace',
  'lease_idle',
  'link_lost',
  'max_lifetime',
  'membership_removed',
  'network_change',
  'process_exited',
  'service_stopped',
  'sleep',
  'ssh_timeout',
  'user_stop',
  'vpn',
] as const;
export type LossCause = (typeof LOSS_CAUSES)[number];

/** A pattern of `ranges` (control characters), built from text so no literal holds them. */
const without = (ranges: string, quantifier: '*' | '+') =>
  new RegExp(`^[^${ranges}]${quantifier}$`);
const v = z.literal(1);
const StreamId = z.number().int().min(1).max(4294967295);
const Port = z.number().int().min(1).max(65535);
const HighPort = z.number().int().min(1024).max(65535);
const Pid = z.number().int().min(1).max(4194304);
const SeqNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A catalogue-shaped code; whether it is a key of the catalogue is checked by its users. */
export const LinkCode = z.string().regex(/^[a-z][a-z0-9_]{2,47}$/);
/** Free text a person may read: at most 512 characters, no control characters but tab and LF. */
export const LinkDetail = z.string().max(512).regex(without('\\x00-\\x08\\x0b-\\x1f\\x7f', '*'));
export const LinkHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:-]+$/);
/** A login name; it cannot start with `-` (an option) nor hold a backslash (§4.4). */
export const LinkUser = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/);
export const LinkPath = z.string().min(1).max(1024).regex(without('\\x00-\\x1f\\x7f', '+'));
const Cidr = z
  .string()
  .max(49)
  .regex(/^[0-9A-Fa-f:.]+\/[0-9]{1,3}$/);
const HostPattern = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[A-Za-z0-9.-]+$/);
const KernelName = z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/);
const ManagedId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const LinkAuth = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('key'), keyPath: LinkPath }),
  z.strictObject({ method: z.literal('agent'), hint: z.string().max(128).optional() }),
  z.strictObject({ method: z.literal('managed_key'), keyId: ManagedId }),
]);

const Hop = z.strictObject({
  host: LinkHost,
  port: Port,
  user: LinkUser,
  auth: LinkAuth.optional(),
});
const HostKey = z.strictObject({ host: LinkHost, port: Port, sha256: ConnectorFingerprint });
export const LinkConfirmation = z.strictObject({
  host: LinkHost,
  port: Port,
  sha256: ConnectorFingerprint,
  replacing: ConnectorFingerprint.optional(),
});

/** Where code runs (§4.4). Never holds a secret: no field exists for one. */
export const LinkTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local'), workspace: LinkPath }),
  z.strictObject({
    kind: z.literal('ssh'),
    host: LinkHost,
    port: Port,
    user: LinkUser,
    jump: Hop.optional(),
    auth: LinkAuth,
    workspace: LinkPath,
    hostKeys: z.array(HostKey).max(2).optional(),
    expectedEnd: UtcTimestamp.optional(),
  }),
  z.strictObject({ kind: z.literal('managed'), targetId: ManagedId, subject: ConnectorUuid }),
]);
export type LinkTarget = z.infer<typeof LinkTarget>;

export const LinkRuntime = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('start'),
    python: LinkPath.optional(),
    login: z.boolean().optional(),
    kernelName: KernelName.optional(),
  }),
  z.strictObject({
    mode: z.literal('attach'),
    port: HighPort,
    pid: Pid.optional(),
    kernelName: KernelName.optional(),
  }),
]);
export type LinkRuntime = z.infer<typeof LinkRuntime>;

export const LinkLease = z.strictObject({
  idleTimeoutMin: z.number().int().min(5).max(240),
  gracePeriodMin: z.number().int().min(1).max(60),
});

export const StageName = z.enum([
  'reachability',
  'host_identity',
  'ssh_auth',
  'workspace',
  'forwarding',
  'runtime',
  'notebook_auth',
  'kernels',
]);
const HopName = z.enum(['jump', 'target']);
const Address = z.string().max(45);

const StageData = z.strictObject({
  hop: HopName.optional(),
  address: Address.optional(),
  fingerprint: ConnectorFingerprint.optional(),
  expected: ConnectorFingerprint.optional(),
  presented: ConnectorFingerprint.optional(),
  algorithm: z.string().max(32).optional(),
  resolvedPath: LinkPath.optional(),
  rootDir: LinkPath.optional(),
  version: z.string().max(32).optional(),
  reason: z.enum(['blocked', 'not_started', 'not_applicable']).optional(),
  blockedBy: StageName.optional(),
  state: z.enum(['startable', 'running']).optional(),
  source: z.enum(['cli', 'service']).optional(),
  terminalPrompt: z.boolean().optional(),
  hops: z
    .array(
      z.strictObject({
        hop: HopName,
        fingerprint: ConnectorFingerprint,
        address: Address.optional(),
      }),
    )
    .min(1)
    .max(2)
    .refine((hops) => hops.length < 2 || (hops[0]?.hop === 'jump' && hops[1]?.hop === 'target'), {
      message: 'two hops are the jump host, then the target',
    })
    .optional(),
});
type StageData = z.infer<typeof StageData>;

/** Keys only a `host_identity` stage reports (its host key evidence, §5.2). */
const HOST_KEY_EVIDENCE = ['hops', 'fingerprint', 'expected', 'presented', 'algorithm'] as const;
const has = (data: StageData | undefined, keys: readonly (keyof StageData)[]) =>
  keys.filter((k) => data?.[k] !== undefined);

/** One stage report (§5.1) with the schema's conditional rules. */
const stage = (allowRunning: boolean) =>
  z
    .strictObject({
      name: StageName,
      status: z.enum(['ok', 'failed', 'skipped', 'needs_action', 'running']),
      code: LinkCode.optional(),
      detail: LinkDetail.optional(),
      data: StageData.optional(),
      ms: z.number().int().min(0).max(3600000).optional(),
    })
    .superRefine((s, ctx) => {
      if (s.status === 'running') {
        if (!allowRunning) {
          ctx.addIssue({
            code: 'custom',
            path: ['status'],
            message: 'running exists only in test_progress',
          });
        } else if (
          s.name !== 'ssh_auth' ||
          s.code !== undefined ||
          s.data?.terminalPrompt !== true
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['data'],
            message: 'a running stage is ssh_auth waiting on the terminal, without a code',
          });
        }
      }
      if (s.name !== 'host_identity') {
        if (has(s.data, HOST_KEY_EVIDENCE).length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['data'],
            message: 'host key evidence belongs to host_identity',
          });
        }
        return;
      }
      if (s.status === 'ok') {
        const others = has(s.data, ['hop', 'fingerprint', 'expected', 'presented', 'algorithm']);
        if (s.data?.hops === undefined || others.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['data'],
            message: 'an ok host_identity reports data.hops only',
          });
        }
      }
      if (
        s.status === 'needs_action' &&
        (s.data?.hop === undefined || s.data.fingerprint === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['data'],
          message: 'needs_action names the hop and fingerprint',
        });
      }
      if (
        s.code === 'host_key_changed' &&
        (s.data?.hop === undefined ||
          s.data.expected === undefined ||
          s.data.presented === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['data'],
          message: 'host_key_changed names hop, expected and presented',
        });
      }
    });
export const LinkStage = stage(true);

export const LinkKernelspec = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  displayName: z.string().max(128),
  language: z.string().max(32),
});
export const LinkEnvironment = z.strictObject({
  os: z.string().max(64).optional(),
  arch: z.string().max(16).optional(),
  runtime: z.string().max(64).optional(),
});
const SessionState = z.enum(['starting', 'ready', 'disconnected', 'stopping', 'stopped', 'failed']);
const SessionCause = z.enum([
  'sleep',
  'vpn',
  'network_change',
  'ssh_timeout',
  'service_stopped',
  'allocation_expired',
  'host_unreachable',
  'process_exited',
  'lease_idle',
  'lease_grace',
  'user_stop',
  'connector_exit',
  'connector_restarted',
  'max_lifetime',
]);
const Headers = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    z.string().max(1024).regex(without('\\x00-\\x1f\\x7f', '*')),
  )
  .refine((h) => Object.keys(h).length <= 16, { message: 'at most 16 headers' });
const ApiPath = z
  .string()
  .max(2048)
  .regex(/^\/api\/[A-Za-z0-9._~%/:@!$&'()*+,;=?-]*$/);

const msg = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.strictObject({ v, t: z.literal(t), ...shape });

export const LinkChallenge = msg('challenge', {
  nonce: B64url32,
  origin: z
    .string()
    .max(255)
    .regex(/^https?:\/\/[a-z0-9.:[\]-]+$/),
  ts: UnixSeconds,
});
export const LinkAuthMessage = msg('auth', {
  connectorId: ConnectorUuid,
  ts: UnixSeconds,
  sig: B64url64,
});
export const LinkLimits = z.strictObject({
  maxStreams: z.number().int().min(1).max(256),
  maxPayload: z.number().int().min(1024).max(1048576),
  initialWindow: z.number().int().min(4096).max(16777216),
  maxControl: z.number().int().min(4096).max(1048576),
  maxSessions: z.number().int().min(1).max(64),
});
export type LinkLimits = z.infer<typeof LinkLimits>;
export const LinkAuthOk = msg('auth_ok', {
  heartbeatSeconds: z.number().int().min(5).max(60),
  limits: LinkLimits,
  minVersion: Semver.optional(),
});
export const LinkHello = msg('hello', {
  version: Semver,
  os: ConnectorOs,
  arch: ConnectorArch,
  mode: z.enum(['personal', 'managed']),
  targets: z
    .array(z.enum(['local', 'ssh', 'managed']))
    .min(1)
    .max(3)
    .refine((t) => new Set(t).size === t.length, { message: 'targets are unique' }),
  features: z.strictObject({ tty: z.boolean(), agent: z.boolean(), wsl: z.boolean() }),
  networkScope: z.strictObject({
    cidrs: z.array(Cidr).max(64),
    hosts: z.array(HostPattern).max(64),
  }),
});
export const LinkTestConnection = msg('test_connection', {
  requestId: ConnectorUuid,
  target: LinkTarget,
  runtime: LinkRuntime,
  confirmations: z.array(LinkConfirmation).max(2).optional(),
});
export const LinkTestProgress = msg('test_progress', {
  requestId: ConnectorUuid,
  stage: LinkStage,
});
export const LinkTestResult = msg('test_result', {
  requestId: ConnectorUuid,
  outcome: z.enum(['ready', 'ready_to_start', 'needs_action', 'failed']),
  stages: z.array(stage(false)).min(1).max(8),
  kernelspecs: z.array(LinkKernelspec).max(32).optional(),
  attachable: z
    .array(z.strictObject({ port: HighPort, pid: Pid.optional(), rootDir: LinkPath }))
    .max(16)
    .optional(),
  jupyterVersion: z
    .string()
    .max(32)
    .regex(/^[0-9]+\.[0-9]+(\.[0-9]+)?[A-Za-z0-9.+-]*$/)
    .optional(),
  environment: LinkEnvironment.optional(),
});
export const LinkOpenSession = msg('open_session', {
  requestId: ConnectorUuid,
  sessionId: ConnectorUuid,
  target: LinkTarget,
  runtime: LinkRuntime,
  lease: LinkLease,
});
/**
 * `session_state.contentRoot` (P3-09b): the workspace relative to the Jupyter server's
 * `root_dir`, `/`-separated, empty when they are equal. Names are never empty, `.`, `..` or
 * hidden, and hold no backslash or control character (design §7).
 */
const rootName = String.raw`[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*`;
export const LinkContentRoot = z
  .string()
  .max(1024)
  .regex(new RegExp(`^(${rootName}(/${rootName})*)?$`));
export const LinkSessionState = msg('session_state', {
  sessionId: ConnectorUuid,
  requestId: ConnectorUuid.optional(),
  state: SessionState,
  owned: z.boolean(),
  phase: z.enum(['attached', 'detached']).optional(),
  cause: SessionCause.optional(),
  code: LinkCode.optional(),
  detail: LinkDetail.optional(),
  jupyterVersion: z.string().max(32).optional(),
  kernelspecs: z.array(LinkKernelspec).max(32).optional(),
  environment: LinkEnvironment.optional(),
  contentRoot: LinkContentRoot.optional(),
  leaseExpiresAt: UtcTimestamp.optional(),
  ts: UnixSeconds,
});
export const LinkCloseSession = msg('close_session', {
  requestId: ConnectorUuid,
  sessionId: ConnectorUuid,
  stop: z.boolean(),
});
export const LinkPresence = msg('presence', { sessionId: ConnectorUuid, attached: z.boolean() });
export const LinkActivity = msg('activity', { sessionId: ConnectorUuid });
export const LinkHttp = msg('http', {
  streamId: StreamId,
  sessionId: ConnectorUuid,
  purpose: z.enum(['session', 'contents']),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: ApiPath,
  headers: Headers,
  body: z.enum(['none', 'stream']),
  contentLength: z.number().int().min(0).max(67108864).optional(),
}).superRefine((m, ctx) => {
  if (m.body === 'stream' && m.contentLength === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['contentLength'],
      message: "body 'stream' needs contentLength",
    });
  }
});
export const LinkHttpHead = msg('http_head', {
  streamId: StreamId,
  status: z.number().int().min(100).max(599),
  headers: Headers,
  body: z.enum(['none', 'stream']),
});
export const LinkWsOpen = msg('ws_open', {
  streamId: StreamId,
  sessionId: ConnectorUuid,
  path: ApiPath,
  protocols: z
    .array(
      z
        .string()
        .max(64)
        .regex(/^[A-Za-z0-9._-]+$/),
    )
    .max(4)
    .optional(),
});
export const LinkWsOpened = msg('ws_opened', {
  streamId: StreamId,
  protocol: z.string().max(64).optional(),
});
export const LinkWsClose = msg('ws_close', {
  streamId: StreamId,
  code: z.number().int().min(1000).max(4999),
  reason: z.string().max(123).optional(),
});
export const LinkWindow = msg('window', {
  streamId: StreamId,
  credit: z.number().int().min(1).max(16777216),
});
export const LinkStreamReset = msg('stream_reset', {
  streamId: StreamId,
  code: LinkCode,
  detail: LinkDetail.optional(),
});
const HeartbeatSession = z.strictObject({
  sessionId: ConnectorUuid,
  state: SessionState,
  phase: z.enum(['attached', 'detached']).optional(),
  cause: SessionCause.optional(),
  leaseExpiresAt: UtcTimestamp.optional(),
  kernels: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        executionState: z.enum(['starting', 'idle', 'busy', 'unknown']),
        lastActivity: UtcTimestamp.optional(),
      }),
    )
    .max(16)
    .optional(),
});
export const LinkHeartbeat = msg('heartbeat', {
  seq: SeqNumber,
  ts: UnixSeconds,
  sessions: z.array(HeartbeatSession).max(64),
});
export const LinkHeartbeatAck = msg('heartbeat_ack', { seq: SeqNumber });
export const LinkError = msg('error', {
  requestId: ConnectorUuid.optional(),
  sessionId: ConnectorUuid.optional(),
  streamId: StreamId.optional(),
  code: LinkCode,
  detail: LinkDetail.optional(),
});

/** Every message the server sends on the link (`#/$defs/ServerMessage`). */
export const LinkServerMessage = z.discriminatedUnion('t', [
  LinkChallenge,
  LinkAuthOk,
  LinkTestConnection,
  LinkOpenSession,
  LinkCloseSession,
  LinkPresence,
  LinkActivity,
  LinkHttp,
  LinkWsOpen,
  LinkWsClose,
  LinkWindow,
  LinkStreamReset,
  LinkHeartbeatAck,
  LinkError,
]);
export type LinkServerMessage = z.infer<typeof LinkServerMessage>;

/** Every message a connector sends on the link (`#/$defs/ConnectorMessage`). */
export const LinkConnectorMessage = z.discriminatedUnion('t', [
  LinkAuthMessage,
  LinkHello,
  LinkTestProgress,
  LinkTestResult,
  LinkSessionState,
  LinkHttpHead,
  LinkWsOpened,
  LinkWsClose,
  LinkWindow,
  LinkStreamReset,
  LinkHeartbeat,
  LinkError,
]);
export type LinkConnectorMessage = z.infer<typeof LinkConnectorMessage>;

/** The `t` values a connector may send; any other is answered `error unsupported_message`. */
export const CONNECTOR_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  LinkConnectorMessage.options.map((o) => o.shape.t.value),
);

/* ------------------------------------------------------------------------------------------ */
/* Semantic target rules (§4.4), applied before the server sends and again by the connector.  */
/* ------------------------------------------------------------------------------------------ */

export interface TargetIssue {
  /** The rule's number in the table of §4.4. */
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  path: (string | number)[];
  message: string;
}

const DOTTED_QUAD =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** The four bytes of a dotted-quad IPv4 address, or null. */
export function ipv4Bytes(host: string): number[] | null {
  return DOTTED_QUAD.test(host) ? host.split('.').map(Number) : null;
}

/** The sixteen bytes of an IPv6 literal (no zone; a trailing dotted quad allowed), or null. */
export function ipv6Bytes(host: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(host)) return null;
  let text = host;
  if (host.includes('.')) {
    // A trailing dotted quad (`::ffff:1.2.3.4`) is the last two groups.
    const at = host.lastIndexOf(':');
    const quad = at < 0 ? null : ipv4Bytes(host.slice(at + 1));
    if (!quad) return null;
    const [a = 0, b = 0, c = 0, d = 0] = quad;
    text = `${host.slice(0, at + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const all = [...head, ...tail];
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const filled =
    halves.length === 2 ? [...head, ...Array<string>(8 - all.length).fill('0'), ...tail] : all;
  return filled.flatMap((g) => {
    const n = Number.parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/** The IPv4 address an IPv6 address embeds by mapping, NAT64 or 6to4 (§8), or null. */
export function embeddedIpv4(b: number[]): number[] | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return b.slice(12);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

/** Whether an IPv4 address is in a class no configuration may allow (§8 "Hard-denied"). */
function hardDeniedV4([a = 0, b = 0, c = 0, d = 0]: number[]): boolean {
  return (
    a === 0 ||
    (a >= 224 && a <= 239) ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a === 169 && b === 254)
  );
}

/** Whether an IPv6 address is unspecified, multicast or link-local (§8 "Hard-denied"). */
function hardDeniedV6(b: number[]): boolean {
  return (
    b.every((x) => x === 0) || b[0] === 0xff || (b[0] === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80)
  );
}

/** Rule 1, then rule 2, for one host. */
function checkHost(host: string, path: (string | number)[]): TargetIssue[] {
  if (host.includes(':')) {
    const bytes = ipv6Bytes(host);
    if (!bytes) return [{ rule: 1, path, message: 'not an IPv6 literal' }];
    const v4 = embeddedIpv4(bytes);
    if (v4 ? hardDeniedV4(v4) : hardDeniedV6(bytes)) {
      return [{ rule: 2, path, message: 'an unspecified, multicast or link-local address' }];
    }
    return [];
  }
  const v4 = ipv4Bytes(host);
  if (v4) {
    return hardDeniedV4(v4)
      ? [{ rule: 2, path, message: 'an unspecified, multicast, broadcast or link-local address' }]
      : [];
  }
  const labels = host.split('.');
  const last = labels.at(-1) ?? '';
  if (!labels.every((l) => LABEL.test(l)) || /^[0-9]+$/.test(last) || /^0x/i.test(last)) {
    return [{ rule: 1, path, message: 'neither a dotted-quad IPv4 address nor a DNS name' }];
  }
  return [];
}

const hasDotDot = (p: string) => p.split(/[\\/]/).includes('..');
const isWindowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p);
/** Absolute on the connector's computer (POSIX or Windows) or under the home directory. */
const isConnectorPath = (p: string) =>
  (p.startsWith('/') || isWindowsAbsolute(p) || p.startsWith('~/')) && !hasDotDot(p);

const sameEndpoint = (a: { host: string; port: number }, b: { host: string; port: number }) =>
  a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;

/**
 * The semantic rules of §4.4 that the schema cannot express, for a target with its runtime and
 * confirmations (a `test_connection` or `open_session` message, or a saved connection). Returns
 * every broken rule; empty means the server may send it. Apply after the schema parse.
 */
export function validateTarget(input: {
  target: LinkTarget;
  runtime?: LinkRuntime;
  confirmations?: z.infer<typeof LinkConfirmation>[];
}): TargetIssue[] {
  const { target, runtime, confirmations } = input;
  const issues: TargetIssue[] = [];
  if (target.kind === 'ssh') {
    issues.push(...checkHost(target.host, ['target', 'host']));
    if (target.jump) issues.push(...checkHost(target.jump.host, ['target', 'jump', 'host']));
  }
  if (target.kind !== 'managed') {
    const ws = target.workspace;
    const absolute =
      target.kind === 'ssh' ? ws.startsWith('/') : ws.startsWith('/') || isWindowsAbsolute(ws);
    if (!absolute || hasDotDot(ws)) {
      issues.push({
        rule: 3,
        path: ['target', 'workspace'],
        message: 'the workspace is absolute with no .. segment',
      });
    }
  }
  if (target.kind === 'ssh') {
    const auths: [z.infer<typeof LinkAuth> | undefined, (string | number)[]][] = [
      [target.auth, ['target', 'auth', 'keyPath']],
      [target.jump?.auth, ['target', 'jump', 'auth', 'keyPath']],
    ];
    for (const [auth, path] of auths) {
      if (auth?.method === 'key' && !isConnectorPath(auth.keyPath)) {
        issues.push({
          rule: 4,
          path,
          message: 'a key path is absolute or starts with ~/, with no .. segment',
        });
      }
    }
  }
  if (runtime?.mode === 'start') {
    if (runtime.python !== undefined && !isConnectorPath(runtime.python)) {
      issues.push({
        rule: 5,
        path: ['runtime', 'python'],
        message: 'python is absolute or starts with ~/, with no .. segment',
      });
    }
    if (runtime.login !== undefined && target.kind !== 'ssh') {
      issues.push({
        rule: 5,
        path: ['runtime', 'login'],
        message: 'login applies to ssh targets only',
      });
    }
  }
  if (target.kind === 'ssh') {
    const named = [target, ...(target.jump ? [target.jump] : [])];
    const keys = target.hostKeys ?? [];
    keys.forEach((k, i) => {
      const duplicate = keys.findIndex((o) => sameEndpoint(o, k)) !== i;
      if (duplicate || !named.some((n) => sameEndpoint(n, k))) {
        issues.push({
          rule: 6,
          path: ['target', 'hostKeys', i],
          message: 'one host key per hop of this target',
        });
      }
    });
    (confirmations ?? []).forEach((c, i) => {
      if (!named.some((n) => sameEndpoint(n, c)) || c.replacing === c.sha256) {
        issues.push({
          rule: 7,
          path: ['confirmations', i],
          message: 'a confirmation names a hop and replaces another key',
        });
      }
    });
    if (target.jump && sameEndpoint(target.jump, target)) {
      issues.push({
        rule: 8,
        path: ['target', 'jump'],
        message: 'the jump host is not the target',
      });
    }
  } else if ((confirmations ?? []).length > 0) {
    issues.push({
      rule: 7,
      path: ['confirmations', 0],
      message: 'only an ssh target has host keys to confirm',
    });
  }
  return issues;
}
