import {
  checkStep,
  completeStep,
  openExercise,
  readExercise,
  restartExercise,
  reviewExercise,
  showHint,
  showSolution,
} from '@parallax/contracts/routes/exercises';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as attempts from '../../db/exercises';
import { registerRoute, settle } from '../register';

export default function exerciseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;

  registerRoute(app, openExercise, async ({ scope, params }) =>
    settle(await attempts.openExercise(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, readExercise, async ({ scope, params }) =>
    settle(await attempts.readExercise(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, checkStep, async ({ scope, params, body, conflict }) => {
    const { outcome, result } = await attempts.checkStep(
      db(),
      scope,
      params.attemptId,
      body,
      now(),
    );
    const attempt = settle(outcome, conflict);
    if (!result) throw new Error('recorded check has no result');
    return { attempt, result };
  });

  registerRoute(app, showHint, async ({ scope, params, body, conflict }) =>
    settle(await attempts.showHint(db(), scope, params.attemptId, body, now()), conflict),
  );

  registerRoute(app, showSolution, async ({ scope, params, body, conflict }) =>
    settle(await attempts.showSolution(db(), scope, params.attemptId, body, now()), conflict),
  );

  registerRoute(app, completeStep, async ({ scope, params, body, conflict }) =>
    settle(await attempts.completeStep(db(), scope, params.attemptId, body, now()), conflict),
  );

  registerRoute(app, restartExercise, async ({ scope, params, conflict }) =>
    settle(await attempts.restartExercise(db(), scope, params.attemptId, now()), conflict),
  );

  registerRoute(app, reviewExercise, async ({ scope, params }) => ({
    attempts: await attempts.reviewAttempts(db(), scope, params.resourceId),
  }));
}
