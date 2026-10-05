import {
  grantOverride,
  keepLocalCopy,
  readAssignment,
  readTest,
  readTestAttempt,
  reviewTestAttempt,
  reviewTestAttempts,
  saveTestAnswer,
  startTestAttempt,
  submitTestAttempt,
  updateAssignment,
} from '@parallax/contracts/routes/tests';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from '../../app';
import type { ClassScope } from '../../auth/scope';
import { enqueueGrading } from '../../db/execution/runs';
import * as tests from '../../db/tests';
import { enqueueTestsExpire } from '../../jobs/tests-expire.job';
import { notFound, registerRoute, settle } from '../register';

export default function testRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;

  /**
   * Queues the deadline job. The attempt is already stored; if queueing fails, every read of the
   * attempt still settles it at its deadline.
   */
  const scheduleExpiry = async (
    req: FastifyRequest,
    scope: ClassScope,
    attemptId: string,
    deadlineAt: Date | null,
  ) => {
    if (!deps.boss || !deadlineAt) return;
    await enqueueTestsExpire(deps.boss, scope, attemptId, deadlineAt).catch((err) =>
      req.log.error({ err, attemptId }, 'could not queue the test deadline job'),
    );
  };

  /**
   * The grading hook (docs/design/runner.md §8.7) after the submission is stored. It is
   * idempotent, so a repeated submit runs it again harmlessly; if it fails, the deadline job and
   * an instructor's read of the results run it again.
   */
  const queueGrading = async (req: FastifyRequest, scope: ClassScope, attemptId: string) => {
    if (!deps.bossExec) return;
    const exec = { boss: deps.bossExec, runtimes: deps.config.RUNNER_RUNTIMES, log: req.log };
    await enqueueGrading(db(), exec, scope, attemptId, now()).catch((err) =>
      req.log.error({ err, attemptId }, 'could not queue the grading runs'),
    );
  };

  registerRoute(app, readTest, async ({ scope, params }) =>
    settle(await tests.readTest(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, startTestAttempt, async ({ scope, params, fail, req }) => {
    const outcome = await tests.startAttempt(db(), scope, params.resourceId, now());
    if (!outcome.ok && outcome.reason === 'not_eligible') {
      return fail(409, { error: 'not_eligible', reason: outcome.why });
    }
    const { started, ...view } = settle(outcome);
    if (started) {
      await scheduleExpiry(req, scope, view.id, view.deadlineAt ? new Date(view.deadlineAt) : null);
    }
    return view;
  });

  registerRoute(app, readTestAttempt, async ({ scope, params }) => {
    return (await tests.readAttempt(db(), scope, params.attemptId, now())) ?? notFound();
  });

  registerRoute(app, saveTestAnswer, async ({ scope, params, body, fail }) => {
    const outcome = await tests.saveAnswer(
      db(),
      scope,
      params.attemptId,
      params.questionId,
      body,
      now(),
    );
    if (!outcome.ok && outcome.reason === 'closed') {
      return fail(409, { error: outcome.error, receipt: outcome.receipt });
    }
    return settle(outcome);
  });

  registerRoute(app, submitTestAttempt, async ({ scope, params, body, fail, req }) => {
    const outcome = await tests.submitAttempt(
      db(),
      scope,
      params.attemptId,
      body.submissionKey,
      now(),
    );
    if (!outcome.ok && outcome.reason === 'closed') {
      return fail(409, { error: outcome.error, receipt: outcome.receipt });
    }
    const receipt = settle(outcome);
    await queueGrading(req, scope, params.attemptId);
    return receipt;
  });

  registerRoute(app, keepLocalCopy, async ({ scope, params, body, fail }) => {
    const outcome = await tests.keepLocalCopy(db(), scope, params.attemptId, body.answers, now());
    if (!outcome.ok && outcome.reason === 'attempt_open') {
      return fail(409, { error: 'attempt_open' });
    }
    return settle(outcome);
  });

  registerRoute(app, readAssignment, async ({ scope, params }) =>
    settle(await tests.readAssignment(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, updateAssignment, async ({ scope, params, body, conflict }) =>
    settle(await tests.updateAssignment(db(), scope, params.resourceId, body, now()), conflict),
  );

  registerRoute(app, grantOverride, async ({ scope, params, body, req }) => {
    const { open, ...granted } = settle(
      await tests.grantOverride(db(), scope, params.resourceId, body, now()),
    );
    if (open) await scheduleExpiry(req, scope, open.attemptId, open.deadlineAt);
    return granted;
  });

  registerRoute(app, reviewTestAttempts, async ({ scope, params }) => ({
    attempts: await tests.reviewAttempts(db(), scope, params.resourceId, now()),
  }));

  registerRoute(app, reviewTestAttempt, async ({ scope, params }) => {
    return (await tests.reviewAttempt(db(), scope, params.attemptId, now())) ?? notFound();
  });
}
