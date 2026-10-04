import {
  createAnnotation,
  createThread,
  deleteAnnotation,
  deletePost,
  editPost,
  listAnnotations,
  listNotifications,
  moderatePost,
  replyToThread,
  saveAnnotation,
  setThreadStatus,
  shareAnnotation,
} from '@parallax/contracts/routes/annotations';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as annotations from '../../db/annotations/annotations';
import { notFound, registerRoute, settle } from '../register';

export default function annotationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;

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

  registerRoute(app, replyToThread, async ({ scope, params, body }) =>
    settle(await annotations.replyToThread(db(), scope, params.threadId, body, now())),
  );

  registerRoute(app, editPost, async ({ scope, params, body }) =>
    settle(await annotations.editPost(db(), scope, params.postId, body, now())),
  );

  registerRoute(app, deletePost, async ({ scope, params }) =>
    settle(await annotations.deletePost(db(), scope, params.postId, now())),
  );

  registerRoute(app, setThreadStatus, async ({ scope, params, body }) =>
    settle(await annotations.setThreadStatus(db(), scope, params.threadId, body.status, now())),
  );

  registerRoute(app, moderatePost, async ({ scope, params, body }) =>
    settle(await annotations.moderatePost(db(), scope, params.postId, body, now())),
  );

  registerRoute(app, listNotifications, async ({ scope }) => ({
    items: await annotations.listNotifications(db(), scope, now()),
  }));
}
