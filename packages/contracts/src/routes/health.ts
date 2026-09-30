import { z } from 'zod';
import { defineRoute } from '../define';

export const health = defineRoute({
  method: 'GET',
  path: '/api/health',
  scope: { kind: 'public' },
  summary: 'Service health',
  response: z.object({
    status: z.literal('ok'),
    version: z.string(),
    db: z.enum(['ok', 'unavailable', 'skipped']),
  }),
  examples: {},
});
