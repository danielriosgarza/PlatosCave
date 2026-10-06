import { getClassReview, getStudentDiscussions } from '@parallax/contracts/routes/review';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { loadClassReview, loadStudentDiscussions } from '../../db/classReview';
import { registerRoute } from '../register';

export default function reviewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerRoute(app, getClassReview, ({ scope, query }) =>
    loadClassReview(deps.requireDb(), scope, query),
  );
  registerRoute(app, getStudentDiscussions, ({ scope, params }) =>
    loadStudentDiscussions(deps.requireDb(), scope, params.studentId, deps.now()),
  );
}
