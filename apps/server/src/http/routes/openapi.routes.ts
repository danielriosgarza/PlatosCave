import { defineRoute } from '@parallax/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../../app';
import { notFound, registerRoute } from '../register';

const openapi = defineRoute({
  method: 'GET',
  path: '/api/openapi.json',
  scope: { kind: 'public' },
  summary: 'OpenAPI document',
  response: z.record(z.string(), z.unknown()),
  examples: {},
});

export default function openapiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // Registered in every environment so the isolation matrix covers it; production answers with
  // the ordinary not-found body, so the API description is not published there.
  registerRoute(app, openapi, () =>
    deps.config.NODE_ENV === 'production' ? notFound() : (app.swagger() as Record<string, unknown>),
  );
}
