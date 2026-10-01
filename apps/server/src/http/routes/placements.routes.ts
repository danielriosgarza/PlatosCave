import { listPlacements, placeMark } from '@parallax/contracts/routes/placements';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import * as placements from '../../db/annotations/annotations';
import { registerRoute, settle } from '../register';

export default function placementRoutes(app: FastifyInstance, deps: Deps): void {
  const db = () => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    return deps.db;
  };
  const now = () => (deps.now ?? (() => new Date()))();

  registerRoute(app, listPlacements, ({ scope }) => placements.listMapping(db(), scope));

  registerRoute(app, placeMark, async ({ scope, body }) => {
    const { anchor, ...target } = body;
    return settle(await placements.placeMark(db(), scope, target, anchor, now()));
  });
}
