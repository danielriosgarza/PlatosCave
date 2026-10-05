import {
  attemptResults,
  cancelRun,
  latestRun,
  readRun,
  requestReplay,
  requestRun,
} from '@parallax/contracts/routes/runs';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as runs from '../../db/execution/runs';
import { notFound, registerRoute, settle } from '../register';

export default function runRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;
  /** The runner's queue and the approved runtimes, or a 503 when no queue is configured. */
  const exec = (): runs.ExecDeps => {
    if (!deps.bossExec) throw app.httpErrors.serviceUnavailable();
    return { boss: deps.bossExec, runtimes: deps.config.RUNNER_RUNTIMES, log: app.log };
  };

  registerRoute(app, requestRun, async ({ scope, params, body, fail, useAlternativeStatus }) => {
    const outcome = await runs.requestRun(
      db(),
      exec,
      scope,
      params.attemptId,
      params.questionId,
      body.files,
      now(),
    );
    if (!outcome.ok && outcome.reason === 'too_many_runs') {
      return fail(429, {
        error: 'too_many_runs',
        active: outcome.active,
        message: outcome.message,
      });
    }
    if (!outcome.ok && outcome.reason === 'attempt_closed') {
      return fail(409, { error: 'attempt_closed' });
    }
    const run = settle(outcome);
    if (run.reused) useAlternativeStatus();
    return run;
  });

  registerRoute(app, readRun, async ({ scope, params }) => {
    return (
      (await runs.readRun(db(), exec, scope, params.attemptId, params.runId, now())) ?? notFound()
    );
  });

  registerRoute(app, latestRun, async ({ scope, params }) => ({
    run: settle(
      await runs.latestRun(db(), exec, scope, params.attemptId, params.questionId, now()),
    ),
  }));

  registerRoute(app, cancelRun, async ({ scope, params, fail }) => {
    const outcome = await runs.cancelRun(db(), exec, scope, params.attemptId, params.runId, now());
    if (!outcome.ok && outcome.reason === 'running') return fail(409, { error: 'running' });
    return settle(outcome);
  });

  registerRoute(app, requestReplay, async ({ scope, params, body, fail }) => {
    const outcome = await runs.requestReplay(
      db(),
      exec,
      scope,
      params.attemptId,
      params.questionId,
      body,
      now(),
    );
    if (
      !outcome.ok &&
      (outcome.reason === 'attempt_open' ||
        outcome.reason === 'no_grading_run' ||
        outcome.reason === 'no_result')
    ) {
      return fail(409, { error: outcome.reason });
    }
    return settle(outcome);
  });

  registerRoute(app, attemptResults, async ({ scope, params }) => {
    const found = await runs.attemptResults(
      db(),
      () => deps.bossExec && exec(),
      scope,
      params.attemptId,
      now(),
    );
    return found ? { runs: found } : notFound();
  });
}
