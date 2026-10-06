import {
  overrideGrade,
  previewGradeRelease,
  readAttemptGrade,
  readMyResults,
  readTestGrades,
  regradeAttempt,
  releaseGrades,
  saveDraftGrade,
  selectReportedAttempt,
} from '@parallax/contracts/routes/grades';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { RouteDeps } from '../../app';
import * as grades from '../../db/grades';
import { notFound, registerRoute, settle } from '../register';

type GradeConflict = z.input<NonNullable<(typeof saveDraftGrade)['errors']>[409]>;

export default function gradeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;

  registerRoute(app, readAttemptGrade, async ({ scope, params }) => {
    return (await grades.readAttemptGrade(db(), scope, params.attemptId, now())) ?? notFound();
  });

  /** A draft save, regrade or override: 409 for an open attempt or a newer grade row. */
  const change = async (
    scope: Parameters<typeof grades.changeGrade>[1],
    attemptId: string,
    body: grades.GradeChange,
    fail: (status: 409, body: GradeConflict) => never,
  ): Promise<grades.AttemptGrade> => {
    const outcome = await grades.changeGrade(db(), scope, attemptId, body, now());
    if (outcome.ok) return outcome.value;
    if (outcome.reason === 'attempt_open') return fail(409, { error: 'attempt_open' });
    if (outcome.reason === 'conflict') {
      return fail(409, { error: 'revision_conflict', current: outcome.current });
    }
    return settle(outcome);
  };

  registerRoute(app, saveDraftGrade, ({ scope, params, body, fail }) =>
    change(scope, params.attemptId, { source: 'draft', ...body }, fail),
  );

  registerRoute(app, regradeAttempt, ({ scope, params, body, fail }) =>
    change(scope, params.attemptId, { source: 'regrade', ...body }, fail),
  );

  registerRoute(app, overrideGrade, ({ scope, params, body, fail }) =>
    change(scope, params.attemptId, { source: 'override', ...body }, fail),
  );

  registerRoute(app, previewGradeRelease, async ({ scope, body }) =>
    grades.previewRelease(db(), scope, body.attemptIds),
  );

  registerRoute(app, releaseGrades, async ({ scope, body, fail }) => {
    const outcome = await grades.releaseGrades(db(), scope, body.grades, now());
    if (!outcome.ok && outcome.reason === 'release_changed') {
      return fail(409, { error: 'release_changed', preview: outcome.preview });
    }
    return settle(outcome);
  });

  registerRoute(app, readTestGrades, async ({ scope, params }) =>
    settle(await grades.testGrades(db(), scope, params.resourceId, now())),
  );

  registerRoute(app, selectReportedAttempt, async ({ scope, params, body }) =>
    settle(await grades.selectReported(db(), scope, params.resourceId, body, now())),
  );

  registerRoute(app, readMyResults, async ({ scope, params }) =>
    settle(await grades.myResults(db(), scope, params.resourceId, now())),
  );
}
