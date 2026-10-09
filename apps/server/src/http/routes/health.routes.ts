import { health } from '@parallax/contracts/routes/health';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from '../../app';
import { probe } from '../../db/client';
import { VERSION } from '../../version';
import { isProbe } from '../probe';
import { registerRoute } from '../register';

export default function healthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { READY_PROBE_TOKEN: token, READY_RATE_LIMIT: limit } = deps.config;
  // Decided once per request, by the limiter, so the limit and the body cannot disagree.
  const probes = new WeakSet<FastifyRequest>();

  registerRoute(
    app,
    health,
    async ({ req }) => {
      // Anyone but a probe learns only that the process answers, and costs no database query.
      if (!probes.has(req)) return { status: 'ok' as const };
      let db: 'ok' | 'unavailable' | 'skipped' = 'skipped';
      if (deps.db) {
        try {
          await probe(deps.db, deps.probeTimeoutMs);
          db = 'ok';
        } catch (err) {
          app.log.warn({ err }, 'health: database unavailable');
          db = 'unavailable';
        }
      }
      return { status: 'ok' as const, version: VERSION, db };
    },
    // Callers without the probe token are limited per address, like /api/ready (its own budget);
    // probes are not counted, so a liveness check never trips it.
    {
      rateLimit: {
        max: limit,
        timeWindow: '1 minute',
        allowList: (req) => {
          const probe = isProbe(req, token);
          if (probe) probes.add(req);
          return probe;
        },
      },
    },
  );
}
