import { health } from '@parallax/contracts/routes/health';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app';
import { probe } from '../../db/client';
import { registerRoute } from '../register';

export default function healthRoutes(app: FastifyInstance, deps: Deps): void {
  registerRoute(app, health, async () => {
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
    return { status: 'ok' as const, version: '0.0.0', db };
  });
}
