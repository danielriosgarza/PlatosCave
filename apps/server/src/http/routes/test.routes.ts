import { buildTestWorld, signInAs } from '@parallax/contracts/routes/test';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { userForVerifiedEmail } from '../../db/auth/accounts';
import { createSession } from '../../db/auth/sessions';
import { registerRoute } from '../register';

/** E2E fixture routes (ADR-0006); mounted only when TEST_ROUTES=1, never in production. */
export default function testRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps;
  if (!config.TEST_ROUTES || config.NODE_ENV === 'production') return;
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => app.resolverDeps.now();
  // One server process serves every Playwright worker: build the world at most once.
  let building: Promise<boolean> | undefined;

  registerRoute(app, buildTestWorld, async () => {
    // The fixtures live with the tests and are loaded only when these routes are used.
    const { ensureWorld, ids } = await import('../../../test/fixtures/world');
    building ??= ensureWorld(db(), now());
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
    const { token } = await createSession(db(), userId, { now: at, authTime });
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config.APP_ORIGIN));
    return { userId };
  });
}
