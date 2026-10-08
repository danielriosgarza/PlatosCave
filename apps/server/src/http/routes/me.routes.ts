import { me } from '@parallax/contracts/routes/me';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../../app';
import { listContexts } from '../../db/identity';
import { registerRoute } from '../register';

export default function meRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerRoute(app, me, async ({ scope }) => {
    const db = deps.requireDb();
    const { user } = scope;
    return {
      user: { id: user.id, name: user.name, email: user.email, kind: user.kind },
      ...(await listContexts(db, scope)),
      defaultLease: {
        idleTimeoutMin: deps.config.LEASE_IDLE_MINUTES,
        gracePeriodMin: deps.config.LEASE_GRACE_MINUTES,
      },
    };
  });
}
