import { z } from 'zod';
import { defineRoute } from '../define';
import { exampleIds } from '../examples';

/**
 * Results export (§12). Class-scoped and instructor-only: one CSV of the selected class's
 * real students' test attempts, handed over as a short-lived download on the content origin.
 */
export const exportClassResults = defineRoute({
  method: 'POST',
  path: '/api/classes/:classId/exports/results',
  scope: { kind: 'class', role: 'instructor' },
  allowWhenArchived: true,
  summary: 'Export the class’s test results as CSV; answers with a short-lived download URL',
  params: z.object({ classId: z.uuid() }),
  status: 201,
  response: z.object({
    url: z.url(),
    expiresAt: z.iso.datetime(),
    filename: z.string(),
    /** Attempts in the file. */
    rows: z.int().min(0),
  }),
  examples: { params: { classId: exampleIds.zero } },
});
