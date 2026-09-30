import { health } from '@parallax/contracts/routes/health';
import type { FastifyInstance } from 'fastify';
import { registerRoute } from '../register';

export default function healthRoutes(app: FastifyInstance): void {
  registerRoute(app, health, () => ({
    status: 'ok' as const,
    version: '0.0.0',
    db: 'skipped' as const,
  }));
}
