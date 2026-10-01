import {
  createResource,
  createTopic,
  getResource,
  listDrafts,
  updateResource,
  updateTopic,
} from '@parallax/contracts/routes/drafts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../../app';
import * as drafts from '../../db/content/drafts';
import { enqueueIfUnprocessed, isProcessed } from '../../jobs/reading-ingest.job';
import { notFound, registerRoute, settle } from '../register';

export default function draftRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => (deps.now ?? (() => new Date()))();

  registerRoute(app, listDrafts, ({ scope }) => drafts.listDrafts(db(), scope));

  registerRoute(app, createTopic, ({ scope, body }) =>
    drafts.createTopic(db(), scope, body, now()),
  );

  registerRoute(app, updateTopic, async ({ scope, params, body, conflict }) =>
    settle(await drafts.updateTopic(db(), scope, params.topicId, body, now()), conflict),
  );

  /**
   * Readings and PDF decks are processed in the background (§8): a new head revision with no job
   * on record is queued. A failure to queue does not undo the save; the editor sees the unprocessed state and
   * can retry from the processing route.
   */
  const queueReading = async (
    scope: Parameters<typeof enqueueIfUnprocessed>[2],
    resource: { type: string; headRevisionId: string | null },
    log: FastifyRequest['log'],
  ) => {
    const processed = isProcessed(resource.type);
    if (!processed || !resource.headRevisionId || !deps.boss) return;
    await enqueueIfUnprocessed(deps.boss, db(), scope, resource.headRevisionId).catch((err) =>
      log.error({ err, courseId: scope.courseId }, 'could not queue reading processing'),
    );
  };

  registerRoute(app, createResource, async ({ scope, params, body, req }) => {
    const created = settle(await drafts.createResource(db(), scope, params.topicId, body, now()));
    await queueReading(scope, created, req.log);
    return created;
  });

  registerRoute(app, getResource, async ({ scope, params }) => {
    return (await drafts.getResource(db(), scope, params.resourceId)) ?? notFound();
  });

  registerRoute(app, updateResource, async ({ scope, params, body, conflict, req }) => {
    const updated = settle(
      await drafts.updateResource(db(), scope, params.resourceId, body, now()),
      conflict,
    );
    await queueReading(scope, updated, req.log);
    return updated;
  });
}
