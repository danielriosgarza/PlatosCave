import {
  closeNotebookSession,
  forgetNotebookSession,
  getNotebookSession,
  listNotebookSessions,
  openNotebookSession,
  type SessionView,
} from '@parallax/contracts/routes/notebookSessions';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { ensureWorkingCopy } from '../../content/workingCopy';
import { connectionForSession } from '../../db/connectors/connections';
import { findSession, listSessions, type SessionRow } from '../../db/notebooks/sessions';
import { notebookRelays } from '../../relay/kernel';
import { WindowLimit } from '../budgets';
import { notFound, registerRoute } from '../register';

/** A session as the routes answer it. */
const sessionView = (row: SessionRow): SessionView => {
  const runtime = row.runtime as SessionView['runtime'];
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectorId: row.connectorId,
    resourceRevisionId: row.resourceRevisionId,
    state: row.state,
    cause: row.cause,
    owned: row.owned,
    runtime: {
      mode: runtime.mode,
      ...(runtime.kernelName && { kernelName: runtime.kernelName }),
      ...(runtime.kernelspecs && { kernelspecs: runtime.kernelspecs }),
    },
    environment: row.environment,
    jupyterVersion: row.jupyterVersion,
    lease: row.lease,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    kernelName: row.kernelName,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  };
};

/**
 * Notebook sessions (docs/design/connector.md §2, §10.3, §10.7): Connect, Disconnect, Stop and
 * Forget. Served in `relay` mode because they need the connector's live link; the session relay
 * follows the links of this process, the only relay (§10.1).
 */
export default function notebookSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { now } = deps;
  const db = deps.requireDb;
  const relay = notebookRelays(app, deps)?.sessions;
  // Without a database there is no relay: every route answers 503, as `requireDb` does.
  const sessions = () => {
    if (!relay) throw app.httpErrors.serviceUnavailable();
    return relay;
  };
  // §10.3: 6 sessions a minute per person, in this process.
  const opened = new WindowLimit({ max: 6, windowMs: 60_000 });

  registerRoute(app, listNotebookSessions, async ({ scope }) => {
    const rows = await listSessions(db(), scope);
    return rows.map(sessionView);
  });

  registerRoute(app, openNotebookSession, async ({ scope, body, fail }) => {
    const found = await connectionForSession(db(), scope, body.connectionId);
    if (!found) return notFound();
    if (!opened.take(scope.user.id, now())) return fail(429, { error: 'too many requests' });
    const result = await sessions().open(scope, found, body);
    if (result.ok) {
      // The first Connect for this notebook revision makes the working copy (design §11). The
      // session is open either way: a copy that could not be made is logged, and the working
      // copy route answers 404 until a later Connect makes it.
      try {
        await ensureWorkingCopy(
          db(),
          deps.storage,
          scope,
          { revisionId: body.revisionId, sessionId: result.sessionId },
          now(),
          app.log,
        );
      } catch (err) {
        app.log.error({ err, sessionId: result.sessionId }, 'making the working copy failed');
      }
      return { sessionId: result.sessionId, state: result.state };
    }
    switch (result.reason) {
      case 'not_found':
        return notFound();
      case 'session_exists':
        return fail(409, { error: 'session_exists', sessionId: result.sessionId });
      case 'target_not_allowed':
        return fail(400, {
          error: 'target_not_allowed',
          code: result.code,
          ...(result.rules && { rules: result.rules }),
        });
      default:
        return fail(409, { error: result.reason });
    }
  });

  registerRoute(app, getNotebookSession, async ({ scope, params }) => {
    const row = await findSession(db(), scope, params.sessionId);
    return row ? sessionView(row) : notFound();
  });

  registerRoute(app, closeNotebookSession, async ({ scope, params, body, fail }) => {
    const row = await findSession(db(), scope, params.sessionId);
    if (!row) return notFound();
    const result = await sessions().close(scope, row, body.stop);
    return result.ok ? sessionView(result.session) : fail(409, { error: result.reason });
  });

  registerRoute(app, forgetNotebookSession, async ({ scope, params, fail }) => {
    const row = await findSession(db(), scope, params.sessionId);
    if (!row) return notFound();
    const forgotten = await sessions().forget(scope, row);
    return forgotten ? sessionView(forgotten) : fail(409, { error: 'not_forgettable' });
  });
}
