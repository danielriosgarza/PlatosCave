import { getTopicReviews, putReviewed } from '@parallax/contracts/routes/topicReviews';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { loadTopicReviews, setReviewed } from '../../db/topicReviews';
import { notFound, registerRoute, settle } from '../register';

export default function topicReviewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerRoute(app, getTopicReviews, async ({ params, scope }) => {
    const found = await loadTopicReviews(deps.requireDb(), scope, params.topicId, deps.now());
    if (!found) notFound();
    return found;
  });

  registerRoute(app, putReviewed, async ({ params, body, scope }) =>
    settle(
      await setReviewed(
        deps.requireDb(),
        scope,
        { topicId: params.topicId, resourceId: params.resourceId, reviewed: body.reviewed },
        deps.now(),
      ),
    ),
  );
}
