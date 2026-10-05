import { z } from 'zod';
import {
  ConnectorName,
  ErrorBody,
  PairRequest,
  PairResponse,
  PollResponse,
  SignedRequest,
} from '../connector';
import { defineRoute, errorBody } from '../define';
import { exampleIds } from '../examples';

/**
 * Connector registry and pairing (docs/design/connector.md §3, §10.3). The `/api/me/connectors`
 * routes act on the signed-in person's own devices; a preview principal is refused with 403,
 * and another person's connector is the shared 404. The `/api/connector/v1` routes are public:
 * a pairing code or an Ed25519 signature is the credential.
 */

const datetime = z.iso.datetime({ offset: true });
const connectorParams = z.object({ connectorId: z.uuid() });
const exampleConnector = { connectorId: exampleIds.aa };
/** A preview principal never manages devices (§3 Controls). */
const preview = z.object({ error: z.literal('forbidden') });

export const ConnectorView = z.object({
  id: z.uuid(),
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  fingerprint: z.string(),
  status: z.enum(['pending', 'active', 'revoked']),
  mode: z.enum(['personal', 'managed']),
  /** Whether the connector holds a live link now. */
  online: z.boolean(),
  lastSeenAt: datetime.nullable(),
  createdAt: datetime,
  /** A pending connector must be approved by then. */
  approveBy: datetime.nullable(),
  networkScope: z.object({ cidrs: z.array(z.string()), hosts: z.array(z.string()) }),
});
export type ConnectorView = z.infer<typeof ConnectorView>;

/**
 * Issues a single-use pairing code valid for 10 minutes, shown once. A person holds at most
 * three live codes (a fourth supersedes the oldest) and may create five an hour (429).
 */
export const createConnectorPairing = defineRoute({
  method: 'POST',
  path: '/api/me/connectors/pairings',
  scope: { kind: 'user' },
  summary: 'Issue a pairing code for a new connector',
  status: 201,
  response: z.object({
    pairingId: z.uuid(),
    /** `XXXX-XXXX`, Crockford base 32. */
    code: z.string(),
    expiresAt: datetime,
  }),
  errors: { 403: preview, 429: errorBody },
  examples: {},
});

/** The person's pending and active connectors, newest first. */
export const listConnectors = defineRoute({
  method: 'GET',
  path: '/api/me/connectors',
  scope: { kind: 'user' },
  summary: "List the signed-in person's connectors",
  response: z.array(ConnectorView),
  errors: { 403: preview },
  examples: {},
});

/**
 * Approves a pending connector after the person compared its fingerprint (§3, step 5). Needs a
 * recent sign-in (401 `recent_auth_required`). 409 `not_pending` for a rejected, revoked or
 * expired one; 409 `too_many_connectors` while five are active.
 */
export const approveConnector = defineRoute({
  method: 'POST',
  path: '/api/me/connectors/:connectorId/approve',
  scope: { kind: 'user' },
  summary: 'Approve a pending connector',
  params: connectorParams,
  response: ConnectorView,
  errors: {
    403: preview,
    409: z.object({ error: z.enum(['not_pending', 'too_many_connectors']) }),
  },
  examples: { params: exampleConnector },
});

/** Rejects a pending connector or revokes an active one; its live link is closed. */
export const revokeConnector = defineRoute({
  method: 'POST',
  path: '/api/me/connectors/:connectorId/revoke',
  scope: { kind: 'user' },
  summary: 'Reject or revoke a connector',
  params: connectorParams,
  response: ConnectorView,
  errors: { 403: preview },
  examples: { params: exampleConnector },
});

/** Renames a pending or active connector. */
export const renameConnector = defineRoute({
  method: 'PATCH',
  path: '/api/me/connectors/:connectorId',
  scope: { kind: 'user' },
  summary: 'Rename a connector',
  params: connectorParams,
  body: z.object({ name: ConnectorName }),
  response: ConnectorView,
  errors: { 403: preview },
  examples: { params: exampleConnector, body: { name: 'Lab workstation' } },
});

/**
 * The pairing body as the route accepts it: the code is checked by the handler, so a malformed
 * code gets the same 404 as an unknown, used or expired one and counts against the caller's
 * failure budget. Every other field is `PairRequest`'s.
 */
const pairBody = PairRequest.extend({ code: z.string().max(64) });

/**
 * Spends a pairing code and registers the connector as pending (§3, step 3). 404 for a bad,
 * used or expired code; 429 once the caller's address failed ten times in ten minutes, or the
 * person already has three pending devices (`too_many_pending`); 400 `key_in_use` when the key
 * is already paired.
 */
export const pairConnector = defineRoute({
  method: 'POST',
  path: '/api/connector/v1/pair',
  scope: { kind: 'public' },
  summary: 'Pair a connector with a pairing code',
  status: 201,
  body: pairBody,
  response: PairResponse,
  errors: {
    400: z.object({ error: z.literal('key_in_use') }),
    404: ErrorBody,
    429: errorBody,
  },
  examples: {
    body: {
      code: 'K7M2Q9XD',
      publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
      name: 'Laptop',
      os: 'linux',
      arch: 'amd64',
      version: '0.1.0',
    },
  },
});

const signedExample = {
  connectorId: '3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b',
  ts: 1790000000,
  sig: 'RL0wYB2Vz64Lwz9WoKZ1jum3fPqHzJmvAsNsrQjVzS2FSdVbq8FIBMXRvdAJLgwB90Zh8rFEVjIBb5lJB6DHBg',
};

/**
 * A connector waiting for approval asks for its state, signed with label
 * `parallax-connector-poll-v1` (§3, step 6). An unknown id, a bad signature or a `ts` more than
 * 120 s off is the shared 404; polling more than once a second is 429.
 */
export const pollPairing = defineRoute({
  method: 'POST',
  path: '/api/connector/v1/pair/poll',
  scope: { kind: 'public' },
  summary: 'Poll a pending connector for approval',
  body: SignedRequest,
  response: PollResponse,
  errors: { 404: ErrorBody, 429: errorBody },
  examples: { body: signedExample },
});

/**
 * A connector revokes itself before deleting its identity, signed with label
 * `parallax-connector-unpair-v1` (§3). Refusals as for the poll.
 */
export const unpairConnector = defineRoute({
  method: 'POST',
  path: '/api/connector/v1/unpair',
  scope: { kind: 'public' },
  summary: 'Unpair a connector',
  body: SignedRequest,
  response: z.object({ status: z.literal('revoked') }),
  errors: { 404: ErrorBody, 429: errorBody },
  examples: { body: signedExample },
});

/**
 * The connector's link (docs/design/connector.md §4): a WebSocket with the subprotocol
 * `parallax.connector.v1`, served in `relay` mode. Public: the challenge and the connector's
 * Ed25519 signature are the credential (§4.2); refusals after the upgrade are close codes (§4.6).
 */
export const connectorLink = defineRoute({
  method: 'GET',
  path: '/api/connector/v1/link',
  scope: { kind: 'public' },
  summary: 'Connector link (WebSocket, subprotocol parallax.connector.v1)',
  websocket: true,
  response: z.never(),
  examples: {},
});
