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
import { notFound, registerRoute } from '../register';

export default function draftRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => (deps.now ?? (() => new Date()))();

  /** Maps a service outcome to the response, a 404, a 409 with the server copy, or a 400. */
  function settle<T>(
    outcome: drafts.Outcome<T>,
    conflict?: (body: { error: 'revision_conflict'; current: T }) => never,
  ): T {
    if (outcome.ok) return outcome.value;
    if (outcome.reason === 'not_found') return notFound();
    if (outcome.reason === 'invalid') throw app.httpErrors.badRequest(outcome.message);
    if (!conflict) throw new Error('unexpected revision conflict');
    return conflict({ error: 'revision_conflict', current: outcome.current });
  }

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
