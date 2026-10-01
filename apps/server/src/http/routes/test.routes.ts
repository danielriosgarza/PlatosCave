import { buildTestWorld, signInAs } from '@parallax/contracts/routes/test';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { userForVerifiedEmail } from '../../auth/accounts';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '../../auth/sessions';
import { classes, users } from '../../db/schema';
import { registerRoute } from '../register';

/** E2E fixture routes (ADR-0006); mounted only when TEST_ROUTES=1, never in production. */
export default function testRoutes(app: FastifyInstance, deps: Deps): void {
  const { config } = app.authDeps;
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
    const { buildWorld, ids } = await import('../../../test/fixtures/world');
    building ??= (async () => {
      const [started] = await db().select().from(users).where(eq(users.id, ids.elena));
      if (!started) {
        await buildWorld(db(), now());
        return true;
      }
      // Adopting v1 in class B is the build's last data step; without it the world is partial.
      const [done] = await db()
        .select({ id: classes.id })
        .from(classes)
        .where(and(eq(classes.id, ids.classB), eq(classes.releaseId, ids.releaseV1)));
      if (!done) throw new Error('the fixture world is half built; reset the e2e database');
      return false;
    })();
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
