import { listPlacements, placeMark } from '@parallax/contracts/routes/placements';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import * as placements from '../../db/annotations/annotations';
import { registerRoute, settle } from '../register';

export default function placementRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const db = deps.requireDb;
  const now = deps.now;

  registerRoute(app, listPlacements, ({ scope }) => placements.listMapping(db(), scope));

  registerRoute(app, placeMark, async ({ scope, body }) => {
    const { anchor, ...target } = body;
    return settle(await placements.placeMark(db(), scope, target, anchor, now()));
  });
}
