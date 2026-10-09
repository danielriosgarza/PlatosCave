import { z } from 'zod';
import { defineRoute, errorBody } from '../define';

/** What a probe sees: the version and whether the database answered. */
const HealthDetail = z.object({
  status: z.literal('ok'),
  version: z.string(),
  db: z.enum(['ok', 'unavailable', 'skipped']),
});

/**
 * `GET /api/health` (docs/operations.md §Readiness and health). A caller bearing the probe token
 * gets the full detail; every other caller gets `status` alone, so the version and the database
 * state are not disclosed (ADR-0002). A union of the two shapes, so a partial body is rejected.
 */
export const HealthBody = z.union([HealthDetail, z.object({ status: z.literal('ok') }).strict()]);

export const health = defineRoute({
  method: 'GET',
  path: '/api/health',
  scope: { kind: 'public' },
  summary: 'Liveness; version and database state for probes only',
  response: HealthBody,
  errors: { 429: errorBody },
  examples: {},
});
