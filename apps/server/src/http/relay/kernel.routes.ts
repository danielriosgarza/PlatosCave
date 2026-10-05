import {
  deleteSessionKernel,
  type ExecutionView,
  getSessionKernel,
  interruptSessionKernel,
  listSessionExecutions,
  restartSessionKernel,
  startSessionKernel,
} from '@parallax/contracts/routes/notebookSessions';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { type ExecutionRow, executionsAfter } from '../../db/notebooks/executions';
import { findSession } from '../../db/notebooks/sessions';
import { type KernelResult, notebookRelays } from '../../relay/kernel';
import { notFound, registerRoute } from '../register';

const executionView = (row: ExecutionRow): ExecutionView => ({
  id: row.id,
  ref: row.clientRef,
  cellId: row.cellId,
  seq: row.seq,
  state: row.state,
  executionCount: row.executionCount,
  outputsIncomplete: row.outputsIncomplete,
  generation: row.kernelGeneration,
  workingCopyRevision: row.workingCopyRevision,
  sentAt: row.sentAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

/**
 * The typed kernel operations of a notebook session (docs/design/connector.md §7, §10.3) and the
 * executions a reloaded page reconciles with (§10.6). Every route reads the session through the
 * caller's class scope: anyone else's session is the shared 404 (A33). Served in `relay` mode.
 */
export default function kernelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const relays = notebookRelays(app, deps);
  const kernels = () => {
    if (!relays) throw app.httpErrors.serviceUnavailable();
    return relays.kernels;
  };
  const answer = (
    result: KernelResult,
    fail: (status: 409, body: { error: string; code?: string }) => never,
  ) =>
    result.ok
      ? { kernel: result.kernel }
      : fail(409, { error: result.reason, ...(result.code && { code: result.code }) });

  registerRoute(app, startSessionKernel, async ({ scope, params, body, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return answer(await kernels().startKernel(session, body.kernelName), fail as never);
  });

  registerRoute(app, getSessionKernel, async ({ scope, params }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return { kernel: await kernels().kernel(session) };
  });

  registerRoute(app, deleteSessionKernel, async ({ scope, params, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return answer(await kernels().deleteKernel(session), fail as never);
  });

  registerRoute(app, interruptSessionKernel, async ({ scope, params, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return answer(await kernels().interrupt(session), fail as never);
  });

  registerRoute(app, restartSessionKernel, async ({ scope, params, fail }) => {
    const session = await findSession(db(), scope, params.sessionId);
    if (!session) return notFound();
    return answer(await kernels().restart(session), fail as never);
  });

  registerRoute(app, listSessionExecutions, async ({ scope, params, query }) => {
    const rows = await executionsAfter(db(), scope, params.sessionId, query.afterSeq);
    if (!rows) return notFound();
    return { executions: rows.map(executionView) };
  });
}
