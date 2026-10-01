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
import type { Deps } from '../../app';
import * as annotations from '../../db/annotations/annotations';
import { notFound, registerRoute, settle } from '../register';

export default function annotationRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => (deps.now ?? (() => new Date()))();

  registerRoute(app, listAnnotations, async ({ scope, params }) => {
    return (await annotations.listForResource(db(), scope, params.resourceId, now())) ?? notFound();
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

  registerRoute(app, deleteAnnotation, async ({ scope, params }) =>
    settle(await annotations.deleteAnnotation(db(), scope, params.annotationId)),
  );

  registerRoute(app, createThread, async ({ scope, params, body }) =>
    settle(await annotations.createThread(db(), scope, params.resourceId, body, now())),
  );

  registerRoute(app, shareAnnotation, async ({ scope, params, body }) =>
    settle(await annotations.shareAnnotation(db(), scope, params.annotationId, body, now())),
  );

  registerRoute(app, listNotifications, async ({ scope }) => ({
    items: await annotations.listNotifications(db(), scope, now()),
  }));
}
