import { me } from '@parallax/contracts/routes/me';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { listContexts } from '../../db/identity';
import { registerRoute } from '../register';

export default function meRoutes(app: FastifyInstance, deps: Deps): void {
  registerRoute(app, me, async ({ scope }) => {
    if (!deps.db) throw app.httpErrors.serviceUnavailable();
    const { user } = scope;
    return {
      user: { id: user.id, name: user.name, email: user.email, kind: user.kind },
      ...(await listContexts(deps.db, scope)),
    };
  });
}
