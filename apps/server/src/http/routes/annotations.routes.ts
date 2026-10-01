import {
  createAnnotation,
  createThread,
  deleteAnnotation,
  listAnnotations,
  listNotifications,
  saveAnnotation,
  shareAnnotation,
} from '@parallax/contracts/routes/annotations';
import type { FastifyInstance } from 'fastify';
import * as annotations from '../../annotations/annotations';
import type { Deps } from '../../app';
import type { Outcome } from '../../content/drafts';
import { notFound, registerRoute } from '../register';

export default function annotationRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => (deps.now ?? (() => new Date()))();

  function settle<T>(
    outcome: Outcome<T>,
    conflict?: (body: { error: 'revision_conflict'; current: T }) => never,
  ): T {
    if (outcome.ok) return outcome.value;
    if (outcome.reason === 'not_found') return notFound();
    if (outcome.reason === 'invalid') throw app.httpErrors.badRequest(outcome.message);
    if (!conflict) throw new Error('unexpected revision conflict');
    return conflict({ error: 'revision_conflict', current: outcome.current });
  }

  registerRoute(app, listAnnotations, async ({ scope, params }) => {
    return (await annotations.listForResource(db(), scope, params.resourceId)) ?? notFound();
  });

  registerRoute(app, createAnnotation, async ({ scope, params, body }) =>
    settle(await annotations.createAnnotation(db(), scope, params.resourceId, body, now())),
  );

  registerRoute(app, saveAnnotation, async ({ scope, params, body, conflict }) =>
    settle(
      await annotations.saveAnnotation(db(), scope, params.annotationId, body, now()),
      conflict,
    ),
  );

  registerRoute(app, deleteAnnotation, async ({ scope, params }) => {
    return (await annotations.deleteAnnotation(db(), scope, params.annotationId)) ?? notFound();
  });

  registerRoute(app, createThread, async ({ scope, params, body }) =>
    settle(await annotations.createThread(db(), scope, params.resourceId, body, now())),
  );

  registerRoute(app, shareAnnotation, async ({ scope, params, body }) =>
    settle(await annotations.shareAnnotation(db(), scope, params.annotationId, body, now())),
  );

  registerRoute(app, listNotifications, async ({ scope }) => ({
    items: await annotations.listNotifications(db(), scope),
  }));
}
