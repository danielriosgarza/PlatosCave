import { z } from 'zod';
import type { ResourceType } from '../db/jobs/derived';

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

export interface ResourceJobStatus {
  resourceId: string;
  topicId: string;
  title: string;
  type: ResourceType;
  revisionId: string | null;
  /**
   * Null when the head revision has no derived outputs to produce, or no revision exists. A
   * status that cannot be read shows as `failed`, so it never disappears from the view.
   */
  status: DerivedStatus | null;
  /** The recorded status as read, for a conditional write (`claimDerivedStatus`); null if none. */
  statusTag: string | null;
}

/** `derived.status` as a job wrote it, or the failure shown for one that cannot be read. */
export function readDerivedStatus(raw: unknown, revisionCreatedAt: Date): DerivedStatus | null {
  if (raw === undefined || raw === null) return null;
  const parsed = DerivedStatus.safeParse(raw);
  if (parsed.success) return parsed.data;
  const job = (raw as { job?: unknown }).job;
  return {
    state: 'failed',
    job: typeof job === 'string' ? job : 'unknown',
    jobId: null,
    error: 'unreadable status',
    updatedAt: revisionCreatedAt.toISOString(),
  };
}
