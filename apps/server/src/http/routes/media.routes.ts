import { getObjectUrl } from '@parallax/contracts/routes/media';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { findReleasedObject, mintContentUrl } from '../../content/media';
import { registerRoute } from '../register';

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/x-ipynb+json': '.ipynb',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'text/csv': '.csv',
};
/** File name for a download: the resource title with filesystem-hostile characters removed. */
function downloadName(title: string, contentType: string): string {
  const base = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim() || 'download';
  const ext = EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] ?? '';
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

export default function mediaRoutes(app: FastifyInstance): void {
  registerRoute(app, getObjectUrl, async ({ params, query, scope, reply }) => {
    const { db, now } = app.resolverDeps;
    const { config } = app.contentDeps;
    const at = now();
    const object = db && (await findReleasedObject(db, scope, params.revisionId, params.key, at));
    if (!object) {
      // Unreleased, hidden, foreign and missing objects all look the same (§2).
      return (reply as FastifyReply).code(404).send({ error: 'not found' });
    }
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
