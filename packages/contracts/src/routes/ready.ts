import { z } from 'zod';
import { defineRoute, errorBody } from '../define';

/**
 * One dependency: `ok` it answered within the deadline, `unavailable` it did not, `skipped` the
 * process was started without it. `required` dependencies decide readiness; the others only
 * limit a feature (code runs answer 503 without the runner's queue). No field carries an error
 * message, host or credential.
 */
const Check = z.object({
  status: z.enum(['ok', 'unavailable', 'skipped']),
  required: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
});

/**
 * `GET /api/ready` (docs/operations.md §Readiness). A probe (the host itself, or a request with
 * the configured token) gets all fields; every other caller gets `status` alone, so the version
 * and which backing service is down are not disclosed (ADR-0002).
 */
export const ReadyBody = z.object({
  status: z.enum(['ready', 'not_ready']),
  version: z.string().optional(),
  mode: z.enum(['api', 'relay']).optional(),
  checks: z
    .object({
      database: Check,
      queue: Check,
      executionQueue: Check,
      storage: Check,
    })
    .optional(),
});

/**
 * Readiness for a load balancer or an orchestrator: 200 when every required dependency answers,
 * 503 with the same body when one does not. `/api/health` stays the liveness probe: it answers
 * 200 while the process runs, whatever its dependencies do.
 */
export const ready = defineRoute({
  method: 'GET',
  path: '/api/ready',
  scope: { kind: 'public' },
  summary: 'Readiness; dependency detail for probes only',
  response: ReadyBody,
  errors: { 429: errorBody, 503: ReadyBody },
  examples: {},
});
