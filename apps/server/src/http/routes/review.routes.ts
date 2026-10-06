import { getClassReview } from '@parallax/contracts/routes/review';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { loadClassReview } from '../../db/classReview';
import { registerRoute } from '../register';

export default function reviewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerRoute(app, getClassReview, ({ scope, query }) =>
    loadClassReview(deps.requireDb(), scope, query),
  );
}
