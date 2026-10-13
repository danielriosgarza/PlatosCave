import { z } from 'zod';

/**
 * State of the job deriving outputs (conversions, page text, block maps) from one resource
 * revision, kept in `resource_revisions.derived.status`: the only column a revision may change
 * after insert (ADR-0003).
 */
export const DerivedStatus = z.object({
  state: z.enum(['queued', 'running', 'ready', 'failed']),
  job: z.string(),
  jobId: z.string().nullable(),
  error: z.string().optional(),
  updatedAt: z.iso.datetime(),
});
export type DerivedStatus = z.infer<typeof DerivedStatus>;

/** Whether the job deriving a revision's outputs has finished (gates publishing slide decks). */
export const derivedReady = (derived: Record<string, unknown>): boolean =>
  DerivedStatus.safeParse(derived.status).data?.state === 'ready';
