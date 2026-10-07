import {
  attemptResults,
  cancelRun,
  latestRun,
  readPreviewRun,
  readRun,
  requestPreviewRun,
  requestReplay,
  requestRun,
} from '@parallax/contracts/routes/runs';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { type ClassScope, resolveActorScope } from '../../auth/scope';
import { previewTarget } from '../../db/execution/previewTarget';
import * as runs from '../../db/execution/runs';
import { previewPrincipals, previewRunClass } from '../../db/preview';
import { perSession } from '../rate-limit';
import { notFound, registerRoute, settle } from '../register';

export default function runRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;
  // One budget per session across the three routes, so it binds each person and not their
  // network (RUN_RATE_LIMIT).
  const runLimit = {
    sharedRateLimit: app.rateLimit(perSession(deps.config.RUN_RATE_LIMIT, '1 minute').rateLimit),
  };
  /** The runner's queue and the approved runtimes, or a 503 when no queue is configured. */
  const exec = (): runs.ExecDeps => {
    if (!deps.bossExec) throw app.httpErrors.serviceUnavailable();
    return { boss: deps.bossExec, runtimes: deps.config.RUNNER_RUNTIMES, log: app.log };
  };

  registerRoute(
    app,
    requestRun,
    async ({ scope, params, body, fail, useAlternativeStatus }) => {
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
    },
    runLimit,
  );

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

  registerRoute(
    app,
    requestReplay,
    async ({ scope, params, body, fail }) => {
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
    },
    runLimit,
  );

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

  /** The class scope of the editor's preview principal, or undefined when there is none. */
  const previewScope = async (userId: string, classId: string): Promise<ClassScope | undefined> => {
    const resolved = await resolveActorScope(db(), userId, { kind: 'class', role: 'any' }, classId);
    return resolved.ok ? (resolved.scope as ClassScope | undefined) : undefined;
  };

  registerRoute(
    app,
    requestPreviewRun,
    async ({ scope, params, body, fail }) => {
      const target = settle(await previewTarget(db(), scope, params.resourceId, params.questionId));
      const home = await previewRunClass(db(), scope);
      if (!home) {
        return fail(409, {
          error: 'no_class',
          message: 'Teach a class of this course to preview runs',
        });
      }
      const classScope = await previewScope(home.previewUserId, home.classId);
      if (!classScope) return notFound();
      return settle(
        await runs.requestPreviewRun(
          db(),
          exec,
          classScope,
          {
            revisionId: target.revisionId,
            questionId: params.questionId,
            set: body.set,
            files: body.files ?? [],
            instructorId: scope.user.id,
          },
          now(),
        ),
      );
    },
    runLimit,
  );

  registerRoute(app, readPreviewRun, async ({ scope, params }) => {
    // The run is found through whichever of the caller's preview principals owns it, so it stays
    // readable if the class new preview runs start in changes while it is in flight.
    for (const home of await previewPrincipals(db(), scope)) {
      const classScope = await previewScope(home.previewUserId, home.classId);
      if (!classScope) continue;
      const run = await runs.readPreviewRun(db(), exec, classScope, params.runId, now());
      if (run) return run;
    }
    return notFound();
  });
}
