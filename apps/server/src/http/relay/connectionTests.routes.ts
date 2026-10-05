import { getConnectionTest, startConnectionTest } from '@parallax/contracts/routes/connections';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import type { UserScope } from '../../auth/scope';
import { findConnection } from '../../db/connectors/connections';
import { ConnectionTests } from '../../relay/tests';
import { WindowLimit } from '../budgets';
import { notFound, registerRoute } from '../register';

/**
 * Test connection (docs/design/connector.md §2 step 3, §5, §10.3): needs the connector's live
 * link, so it is served in `relay` mode. Runs are held by this process, which is the only relay
 * (§10.1).
 */
export default function connectionTestRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { now, links } = deps;
  const db = deps.requireDb;
  let tests: ConnectionTests | undefined;
  const runs = () => {
    tests ??= new ConnectionTests({
      db: db(),
      links,
      now,
      log: app.log.child({ component: 'tests' }),
    });
    return tests;
  };
  // §10.3: 6 tests a minute per person, in this process.
  const started = new WindowLimit({ max: 6, windowMs: 60_000 });

  const person = (scope: UserScope, fail: (status: 403, body: { error: 'forbidden' }) => never) => {
    if (scope.user.kind === 'preview') fail(403, { error: 'forbidden' });
    return scope;
  };

  registerRoute(app, startConnectionTest, async ({ scope, params, body, fail }) => {
    const connection = await findConnection(db(), person(scope, fail), params.connectionId);
    if (!connection) return notFound();
    const confirmations = body.confirmations ?? [];
    // Replacing a remembered key is a deliberate act: it needs a recent sign-in (§5.2).
    if (confirmations.some((c) => c.replacing !== undefined)) scope.requireRecentAuth();
    if (!started.take(scope.user.id, now())) return fail(429, { error: 'too many requests' });
    const result = runs().start(scope, connection, confirmations);
    if (result.ok) return { testId: result.testId };
    if (result.reason === 'target_not_allowed') {
      return fail(400, {
        error: 'target_not_allowed',
        code: result.code,
        ...(result.rules && { rules: result.rules }),
      });
    }
    return fail(409, { error: result.reason });
  });

  registerRoute(app, getConnectionTest, async ({ scope, params, fail }) => {
    const view = await runs().view(person(scope, fail), params.connectionId, params.testId);
    return view ?? notFound();
  });
}
