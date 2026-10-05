import { createTransfer, listSessionFiles } from '@parallax/contracts/routes/transfers';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { findSession } from '../../db/notebooks/sessions';
import { type Refusal, transferRelay, transferView } from '../../relay/transfers';
import { notFound, registerRoute } from '../register';

/**
 * The workspace of a notebook session (docs/design/connector.md §11): listing confined to the
 * workspace, copy-in, Save to computer, Import and copy-out. Served in `relay` mode because each
 * needs the connector's live link. Every route reads the session through the caller's class
 * scope: anyone else's is the shared 404 (A33).
 */
export default function transferRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const relay = transferRelay(app, deps);
  const transfers = () => {
    if (!relay) throw app.httpErrors.serviceUnavailable();
    return relay;
  };

  /** The answer to a refused transfer: 400 for a request that cannot be placed, else 409. */
  const refuse = (refusal: Refusal, fail: (status: 400 | 409, body: object) => never): never => {
    switch (refusal.reason) {
      case 'invalid':
        return fail(400, { error: 'invalid', message: refusal.message });
      case 'revision_conflict':
        return fail(409, { error: 'revision_conflict', current: refusal.current });
      case 'class_archived':
        return fail(409, { error: 'class_archived' });
      default:
        return fail(409, { error: refusal.reason, ...(refusal.code && { code: refusal.code }) });
    }
  };

  registerRoute(app, listSessionFiles, async ({ scope, params, query, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    const result = await transfers().files(scope, session, query.dir);
    if (!result.ok) return refuse(result, fail as never);
    return {
      workspace: result.workspace,
      host: result.host,
      dir: result.dir,
      entries: result.entries,
      declared: result.declared.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    };
  });

  registerRoute(app, createTransfer, async ({ scope, params, body, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    const result = await transfers().transfer(scope, session, body);
    if (!result.ok) return refuse(result, fail as never);
    return {
      transfers: result.transfers.map(transferView),
      ...(result.workingCopy && { workingCopy: result.workingCopy }),
    };
  });
}
