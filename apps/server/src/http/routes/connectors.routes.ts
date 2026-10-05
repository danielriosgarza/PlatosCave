import {
  approveConnector,
  type ConnectorView,
  createConnectorPairing,
  listConnectors,
  pairConnector,
  pollPairing,
  renameConnector,
  revokeConnector,
  unpairConnector,
} from '@parallax/contracts/routes/connectors';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import type { UserScope } from '../../auth/scope';
import { createPairing, normalisePairingCode, pairingKey } from '../../db/connectors/pairing';
import * as registry from '../../db/connectors/registry';
import {
  decodeB64url,
  normaliseOrigin,
  type SignedBody,
  verifySignedRequest,
} from '../../relay/signing';
import { FailureBudget, Throttle, WindowLimit } from '../budgets';
import { NOT_FOUND, notFound, registerRoute } from '../register';

/** The close code a revoked connector's link gets (docs/design/connector.md §4.6). */
const CLOSE_REVOKED = 4403;
/** How often a pending connector polls (§3, step 6). */
const POLL_AFTER_SECONDS = 2;

const perAddress = (max: number, timeWindow: string) => ({ rateLimit: { max, timeWindow } });

export default function connectorRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, now } = deps;
  const db = deps.requireDb;
  const { links } = deps;
  const key = pairingKey(config.SESSION_SECRET);
  const origin = normaliseOrigin(config.APP_ORIGIN);
  // §3 Controls: a person creates at most 5 codes an hour; an address is blocked for 10 minutes
  // after 10 failed pairings in 10 minutes; one connector polls at most once a second. Counted
  // per person (not per session, which a person can hold several of) and in this process, which
  // is the only one (docs/design/connector.md §10.1).
  const creations = new WindowLimit({ max: 5, windowMs: 3_600_000 });
  const pairFailures = new FailureBudget({ max: 10, windowMs: 600_000, blockMs: 600_000 });
  const polls = new Throttle(1000);

  const toView = (row: registry.ConnectorRow): ConnectorView => ({
    ...row,
    online: links.get(row.id) !== undefined,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    approveBy: row.approveBy?.toISOString() ?? null,
  });

  /** §3 Controls: managing devices needs a real person; a preview principal gets 403. */
  const person = (scope: UserScope, fail: (status: 403, body: { error: 'forbidden' }) => never) => {
    if (scope.user.kind === 'preview') fail(403, { error: 'forbidden' });
    return scope;
  };

  registerRoute(app, createConnectorPairing, async ({ scope, fail }) => {
    const at = now();
    if (!creations.take(person(scope, fail).user.id, at)) {
      return fail(429, { error: 'too many requests' });
    }
    const pairing = await createPairing(db(), scope, key, at);
    return { ...pairing, expiresAt: pairing.expiresAt.toISOString() };
  });

  registerRoute(app, listConnectors, async ({ scope, fail }) => {
    const rows = await registry.listConnectors(db(), person(scope, fail), now());
    return rows.map(toView);
  });

  registerRoute(app, approveConnector, async ({ scope, params, fail }) => {
    person(scope, fail).requireRecentAuth();
    const result = await registry.approveConnector(db(), scope, params.connectorId, now());
    if (result.ok) return toView(result.connector);
    if (result.reason === 'not_found') return notFound();
    return fail(409, { error: result.reason });
  });

  registerRoute(app, revokeConnector, async ({ scope, params, fail }) => {
    const result = await registry.revokeConnector(
      db(),
      person(scope, fail),
      params.connectorId,
      now(),
    );
    if (!result.ok) return notFound();
    if (result.revoked) links.get(result.connector.id)?.close(CLOSE_REVOKED, 'revoked');
    return toView(result.connector);
  });

  registerRoute(app, renameConnector, async ({ scope, params, body, fail }) => {
    const row = await registry.renameConnector(
      db(),
      person(scope, fail),
      params.connectorId,
      body.name,
    );
    return row ? toView(row) : notFound();
  });

  registerRoute(
    app,
    pairConnector,
    async ({ body, req, fail }) => {
      const at = now();
      if (pairFailures.blocked(req.ip, at)) return fail(429, { error: 'too many requests' });
      const code = normalisePairingCode(body.code);
      const publicKey = decodeB64url(body.publicKey, 32);
      if (!publicKey) throw app.httpErrors.badRequest('publicKey is not 32 bytes of base64url');
      const result = code
        ? await registry.createPendingConnector(db(), key, { ...body, code, publicKey }, at)
        : ({ ok: false, reason: 'not_found' } as const);
      if (result.ok) {
        return {
          connectorId: result.connectorId,
          fingerprint: result.fingerprint,
          status: 'pending' as const,
          pollAfterSeconds: POLL_AFTER_SECONDS,
          approveBy: result.approveBy.toISOString(),
        };
      }
      if (result.reason === 'not_found') {
        pairFailures.fail(req.ip, at);
        return fail(404, NOT_FOUND);
      }
      if (result.reason === 'key_in_use') return fail(400, { error: 'key_in_use' });
      return fail(429, { error: 'too_many_pending' });
    },
    perAddress(60, '1 minute'),
  );

  /** The connector a signed request names, when its signature and time hold; else the 404. */
  const verified = async (kind: 'poll' | 'unpair', body: SignedBody) => {
    const row = await registry.findSigningConnector(db(), body.connectorId);
    if (!row || !verifySignedRequest(kind, body, row.publicKey, origin, now())) notFound();
    return row as NonNullable<typeof row>;
  };

  registerRoute(
    app,
    pollPairing,
    async ({ body, fail }) => {
      const row = await verified('poll', body);
      if (!polls.allow(row.id, now())) return fail(429, { error: 'too many requests' });
      const status = await registry.pollConnector(db(), row.id, now());
      return status === 'pending' ? { status, pollAfterSeconds: POLL_AFTER_SECONDS } : { status };
    },
    perAddress(120, '1 minute'),
  );

  registerRoute(
    app,
    unpairConnector,
    async ({ body }) => {
      const row = await verified('unpair', body);
      if (await registry.unpairConnector(db(), row.id, now())) {
        links.get(row.id)?.close(CLOSE_REVOKED, 'revoked');
      }
      return { status: 'revoked' as const };
    },
    perAddress(30, '1 minute'),
  );
}
