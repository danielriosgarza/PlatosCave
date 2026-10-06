import { exportClassResults } from '@parallax/contracts/routes/exports';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { downloadName, mintContentUrl } from '../../content/media';
import { recordResultsExport, resultsCsv } from '../../db/gradeExport';
import { registerRoute } from '../register';

export default function exportRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, storage, now } = deps;

  registerRoute(app, exportClassResults, async ({ scope }) => {
    const db = deps.requireDb();
    const at = now();
    const { csv, rows } = await resultsCsv(db, scope);
    // Stored inside the class's own area, so a token minted here cannot name another class's file.
    const stored = await storage.put(`classes/${scope.classId}/exports`, Buffer.from(csv, 'utf8'));
    await recordResultsExport(db, scope, { ...stored, rows }, at);
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
    return { url, expiresAt, filename, rows };
  });
}
