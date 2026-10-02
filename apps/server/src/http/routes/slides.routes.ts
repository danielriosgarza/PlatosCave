import { getSlides, listSlides } from '@parallax/contracts/routes/slides';
import type { FastifyInstance } from 'fastify';
import { mintContentUrl } from '../../content/media';
import { listTopicDecks, loadDeck } from '../../db/slides';
import { notFound, registerRoute } from '../register';

export default function slideRoutes(app: FastifyInstance): void {
  const deps = () => {
    const { db, now } = app.resolverDeps;
    if (!db) throw app.httpErrors.serviceUnavailable();
    return { db, at: now() };
  };

  registerRoute(app, listSlides, async ({ params, scope }) => {
    const { db, at } = deps();
    const found = await listTopicDecks(db, scope, params.topicId, at);
    if (!found) notFound();
    return found;
  });

  registerRoute(app, getSlides, async ({ params, scope }) => {
    const { db, at } = deps();
    const { config } = app.contentDeps;
    const deck = await loadDeck(db, scope, params.revisionId, at);
    if (!deck) notFound();
    const { pdf, ...rest } = deck;
    return {
      ...rest,
      pdf: pdf && {
        ...mintContentUrl(
          { contentOrigin: config.CONTENT_ORIGIN, secret: config.CONTENT_TOKEN_SECRET, now: at },
          scope,
          { key: pdf.key, contentType: 'application/pdf' },
          { disposition: 'inline' },
        ),
        pageCount: pdf.pageCount,
      },
    };
  });
}
