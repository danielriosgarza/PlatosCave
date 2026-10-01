import {
  createResource,
  createTopic,
  getResource,
  listDrafts,
  updateResource,
  updateTopic,
} from '@parallax/contracts/routes/drafts';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import * as drafts from '../../content/drafts';
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

  registerRoute(app, createResource, async ({ scope, params, body }) =>
    settle(await drafts.createResource(db(), scope, params.topicId, body, now())),
  );

  registerRoute(app, getResource, async ({ scope, params }) => {
    return (await drafts.getResource(db(), scope, params.resourceId)) ?? notFound();
  });

  registerRoute(app, updateResource, async ({ scope, params, body, conflict }) =>
    settle(await drafts.updateResource(db(), scope, params.resourceId, body, now()), conflict),
  );
}
