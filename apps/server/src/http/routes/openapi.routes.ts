import { defineRoute } from '@parallax/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerRoute } from '../register';

const openapi = defineRoute({
  method: 'GET',
  path: '/api/openapi.json',
  scope: { kind: 'public' },
  summary: 'OpenAPI document',
  response: z.record(z.string(), z.unknown()),
  examples: {},
});

export default function openapiRoutes(app: FastifyInstance): void {
  registerRoute(app, openapi, () => app.swagger() as Record<string, unknown>);
}
