import { getReading, listReadings, putPosition } from '@parallax/contracts/routes/readings';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { mintContentUrl } from '../../content/media';
import { resolveReadingImages } from '../../content/reading';
import { listTopicReadings, loadReading, savePosition } from '../../db/readings';
import { notFound, registerRoute, settle } from '../register';

export default function readingRoutes(app: FastifyInstance, routeDeps: RouteDeps): void {
  const deps = () => {
    const { db, now } = app.resolverDeps;
    if (!db) throw app.httpErrors.serviceUnavailable();
    return { db, at: now() };
  };

  registerRoute(app, listReadings, async ({ params, scope }) => {
    const { db, at } = deps();
    const found = await listTopicReadings(db, scope, params.topicId, at);
    if (!found) notFound();
    return found;
  });

  registerRoute(app, getReading, async ({ params, scope }) => {
    const { db, at } = deps();
    const { config } = routeDeps;
    const reading = await loadReading(db, scope, params.revisionId, at);
    if (!reading) notFound();
    const mint = (key: string, contentType: string) =>
      mintContentUrl(
        {
          contentOrigin: config.CONTENT_ORIGIN,
          secret: config.CONTENT_TOKEN_SECRET,
          now: at,
        },
        scope,
        { key, contentType },
        { disposition: 'inline' },
      );
    const { objects, pdf, html, ...rest } = reading;
    return {
      ...rest,
      html:
        html === null
          ? null
          : resolveReadingImages(html, (key) => {
              const contentType = objects[key];
              if (!contentType) return null;
              try {
                return mint(key, contentType).url;
              } catch {
                // A key the token scope refuses leaves the image to its alt text, not the page.
                return null;
              }
            }),
      pdf: pdf && {
        ...mint(pdf.key, 'application/pdf'),
        pageCount: pdf.pageCount,
      },
    };
  });

  registerRoute(app, putPosition, async ({ body, scope }) => {
    const { db, at } = deps();
    return settle(await savePosition(db, scope, body, at));
  });
}
