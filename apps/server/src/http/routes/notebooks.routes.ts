import type { NotebookOutput, NotebookView, StoredNotebook } from '@parallax/contracts';
import { getNotebook, listNotebooks } from '@parallax/contracts/routes/notebooks';
import type { FastifyInstance } from 'fastify';
import { mintContentUrl } from '../../content/media';
import { resolveReadingImages } from '../../content/reading';
import { listTopicNotebooks, loadNotebook } from '../../db/notebooks';
import { notFound, registerRoute } from '../register';

/**
 * The stored notebook with each object it names turned into a short-lived link on the content
 * origin, minted for the caller. `urlFor` refuses keys the import did not store.
 */
export function notebookView(
  stored: StoredNotebook,
  urlFor: (key: string) => string | null,
): NotebookView {
  const output = (o: StoredNotebook['cells'][number] & { type: 'code' }) =>
    o.outputs.map((out): NotebookOutput => {
      if (out.type === 'image') {
        const { key: _key, contentType: _type, ...rest } = out;
        return { ...rest, url: urlFor(out.key) };
      }
      if (out.type === 'html') {
        const { key: _key, ...rest } = out;
        return { ...rest, url: urlFor(out.key) };
      }
      if (out.type === 'markdown') return { ...out, html: resolveReadingImages(out.html, urlFor) };
      return out;
    });
  return {
    ...stored,
    cells: stored.cells.map((cell) =>
      cell.type === 'code'
        ? { ...cell, outputs: output(cell) }
        : cell.type === 'markdown'
          ? { ...cell, html: resolveReadingImages(cell.html, urlFor) }
          : cell,
    ),
  };
}

export default function notebookRoutes(app: FastifyInstance): void {
  const deps = () => {
    const { db, now } = app.resolverDeps;
    if (!db) throw app.httpErrors.serviceUnavailable();
    return { db, at: now() };
  };

  registerRoute(app, listNotebooks, async ({ params, scope }) => {
    const { db, at } = deps();
    return (await listTopicNotebooks(db, scope, params.topicId, at)) ?? notFound();
  });

  registerRoute(app, getNotebook, async ({ params, scope }) => {
    const { db, at } = deps();
    const { config } = app.contentDeps;
    const found = await loadNotebook(db, scope, params.revisionId, at);
    if (!found) notFound();
    const { objects, notebook, ...rest } = found;
    const urlFor = (key: string) => {
      const contentType = objects[key];
      if (!contentType) return null;
      try {
        return mintContentUrl(
          { contentOrigin: config.CONTENT_ORIGIN, secret: config.CONTENT_TOKEN_SECRET, now: at },
          scope,
          { key, contentType },
          { disposition: 'inline' },
        ).url;
      } catch {
        // A key the token scope refuses leaves the output to its alt text, not the page.
        return null;
      }
    };
    return { ...rest, notebook: notebook && notebookView(notebook, urlFor) };
  });
}
