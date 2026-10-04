import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';

/** A content-addressed storage key, `courses/{courseId}/objects/{sha256}` (ADR-0003). */
const ObjectKey = z.string().regex(/^courses\/[0-9a-f-]{36}\/objects\/[0-9a-f]{64}$/);

export const getObjectUrl = defineRoute({
  method: 'GET',
  path: '/api/classes/:classId/resources/:revisionId/objects/:key',
  scope: { kind: 'class', role: 'any' },
  summary:
    'Short-lived content-origin URL for one object of a resource revision in the class release',
  params: z.object({ classId: z.uuid(), revisionId: z.uuid(), key: ObjectKey }),
  query: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }),
  response: z.object({ url: z.url(), expiresAt: z.iso.datetime() }),
  examples: {
    params: {
      classId: exampleIds.zero,
      revisionId: exampleIds.zero,
      key: `courses/${exampleIds.zero}/objects/${'0'.repeat(64)}`,
    },
    query: {},
  },
});
