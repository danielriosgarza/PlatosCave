import { exportClassResults } from '@parallax/contracts/routes/exports';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { downloadName, mintContentUrl } from '../../content/media';
import { recordResultsExport, resultsFile } from '../../db/gradeExport';
import { classExportPrefix } from '../../storage/storage';
import { registerRoute } from '../register';

export default function exportRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, storage, now } = deps;

  registerRoute(app, exportClassResults, async ({ scope }) => {
    const db = deps.requireDb();
    const at = now();
    const file = await resultsFile(db, scope, at);
    // Audited first, so every stored file has its event; the key is the content address.
    await recordResultsExport(db, scope, file, at);
    const stored = await storage.put(classExportPrefix(scope.classId), file.body);
    const contentType = 'text/csv; charset=utf-8';
    const filename = downloadName(
      `${scope.courseTitle} ${scope.className} results ${at.toISOString().slice(0, 10)}`,
      'text/csv',
    );
    const { url, expiresAt } = mintContentUrl(
      { contentOrigin: config.CONTENT_ORIGIN, secret: config.CONTENT_TOKEN_SECRET, now: at },
      scope,
      { key: stored.key, contentType },
      { disposition: 'attachment', filename },
    );
    return { url, expiresAt, filename, rows: file.rows };
  });
}
