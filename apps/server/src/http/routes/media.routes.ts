import { getObjectUrl } from '@parallax/contracts/routes/media';
import type { FastifyInstance } from 'fastify';
import { downloadName, findReleasedObject, mintContentUrl } from '../../content/media';
import { notFound, registerRoute } from '../register';

export default function mediaRoutes(app: FastifyInstance): void {
  registerRoute(app, getObjectUrl, async ({ params, query, scope }) => {
    const { db, now } = app.resolverDeps;
    const { config } = app.contentDeps;
    const at = now();
    const object = db && (await findReleasedObject(db, scope, params.revisionId, params.key, at));
    // Unreleased, hidden, foreign and missing objects all look the same (§2).
    if (!object) notFound();
    return mintContentUrl(
      { contentOrigin: config.CONTENT_ORIGIN, secret: config.CONTENT_TOKEN_SECRET, now: at },
      scope,
      object,
      {
        disposition: query.disposition,
        ...(query.disposition === 'attachment' && {
          filename: downloadName(object.title, object.contentType),
        }),
      },
    );
  });
}
