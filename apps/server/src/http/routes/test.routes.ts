import {
  approveConnectorForTest,
  buildTestWorld,
  dropConnectorLink,
  signInAs,
} from '@parallax/contracts/routes/test';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { userForVerifiedEmail } from '../../db/auth/accounts';
import { createSession } from '../../db/auth/sessions';
import { approveConnector, listConnectors } from '../../db/connectors/registry';
import { notFound, registerRoute } from '../register';

/** E2E fixture routes (ADR-0006); mounted only when TEST_ROUTES=1, never in production. */
export default function testRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;
  if (!config.TEST_ROUTES || config.NODE_ENV === 'production') return;
  const db = deps.requireDb;
  const now = deps.now;
  // One server process serves every Playwright worker: build the world at most once.
  let building: Promise<boolean> | undefined;

  registerRoute(app, buildTestWorld, async () => {
    // The fixtures live with the tests and are loaded only when these routes are used.
    const { ensureWorld, ids } = await import('../../../test/fixtures/world');
    building ??= ensureWorld(db(), now(), deps.storage);
    try {
      return { ids, created: await building };
    } catch (err) {
      building = undefined;
      throw err;
    }
  });

  registerRoute(app, signInAs, async ({ body, reply }) => {
    const userId = await userForVerifiedEmail(db(), body.email);
    const at = now();
    const authTime = new Date(at.getTime() - body.authenticatedMinutesAgo * 60_000);
    const ttlMs = config.SESSION_TTL_MS;
    const { token } = await createSession(db(), userId, { now: at, authTime, ttlMs });
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config.APP_ORIGIN, ttlMs));
    return { userId };
  });

  // Connector fixtures (docs/design/connector.md §15): the owner approves through the same
  // service as the Approve button, and a test can cut a live link. Both act only on the
  // signed-in person's own connectors.
  const { links } = deps;

  registerRoute(app, approveConnectorForTest, async ({ scope, params, fail }) => {
    const result = await approveConnector(db(), scope, params.connectorId, now());
    if (result.ok) return { status: 'active' as const };
    if (result.reason === 'not_found') return notFound();
    return fail(409, { error: result.reason });
  });

  registerRoute(app, dropConnectorLink, async ({ scope, params }) => {
    const own = await listConnectors(db(), scope, now());
    if (!own.some((c) => c.id === params.connectorId)) return notFound();
    const link = links.get(params.connectorId);
    link?.close(1001, '');
    return { dropped: link !== undefined };
  });
}
