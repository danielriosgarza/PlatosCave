import {
  archiveConnection,
  type ConnectionView,
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
} from '@parallax/contracts/routes/connections';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import type { UserScope } from '../../auth/scope';
import * as connections from '../../db/connectors/connections';
import { notFound, registerRoute } from '../register';

/** A connection as the routes answer it. */
export const connectionView = (row: connections.OwnedConnection): ConnectionView => ({
  id: row.id,
  name: row.name,
  connectorId: row.connectorId,
  target: row.target,
  runtime: row.runtime,
  templateId: row.templateId,
  trustedHostKeys: row.trustedHostKeys,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

/**
 * Saved connections (docs/design/connector.md §2, §10.3): `/api/me/connections`. A preview
 * principal never manages connections (403); another person's connection is the shared 404.
 * Test connection needs a live link and is served in `relay` mode (http/relay/).
 */
export default function connectionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { now } = deps;
  const db = deps.requireDb;

  const person = (scope: UserScope, fail: (status: 403, body: { error: 'forbidden' }) => never) => {
    if (scope.user.kind === 'preview') fail(403, { error: 'forbidden' });
    return scope;
  };

  registerRoute(app, listConnections, async ({ scope, fail }) => {
    const rows = await connections.listConnections(db(), person(scope, fail));
    return rows.map(connectionView);
  });

  registerRoute(app, createConnection, async ({ scope, body, fail }) => {
    const result = await connections.createConnection(db(), person(scope, fail), body, now());
    if (result.ok) return connectionView(result.connection);
    if (result.reason === 'not_found') return notFound();
    if (result.reason === 'target_not_allowed') {
      return fail(400, {
        error: 'target_not_allowed',
        code: result.code,
        ...(result.rules && { rules: result.rules }),
      });
    }
    return fail(409, { error: result.reason });
  });

  registerRoute(app, getConnection, async ({ scope, params, fail }) => {
    const row = await connections.findConnection(db(), person(scope, fail), params.connectionId);
    return row ? connectionView(row) : notFound();
  });

  registerRoute(app, updateConnection, async ({ scope, params, body, fail }) => {
    const result = await connections.updateConnection(
      db(),
      person(scope, fail),
      params.connectionId,
      body,
      now(),
    );
    if (result.ok) return connectionView(result.connection);
    if (result.reason === 'target_not_allowed') {
      return fail(400, {
        error: 'target_not_allowed',
        code: result.code,
        ...(result.rules && { rules: result.rules }),
      });
    }
    if (result.reason === 'name_taken') return fail(409, { error: 'name_taken' });
    return notFound();
  });

  registerRoute(app, archiveConnection, async ({ scope, params, fail }) => {
    const result = await connections.archiveConnection(
      db(),
      person(scope, fail),
      params.connectionId,
      now(),
    );
    if (result.ok) return connectionView(result.connection);
    if (result.reason === 'not_found') return notFound();
    return fail(409, { error: 'in_use', sessionId: result.sessionId });
  });
}
