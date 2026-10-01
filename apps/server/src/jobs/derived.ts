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
  /** Identifies the recorded status as read, for a guarded write (`StatusGuard.tag`); null if none. */
  statusTag: string | null;
}

/**
 * pg-boss states in which a job may still write its status; any other state, or no job row at
 * all, means it ended without writing (refused, dead-lettered, expired past its retries, or
 * deleted by retention).
 */
const LIVE_JOB_STATES = new Set(['created', 'retry', 'active']);

/**
 * How long a status may stay pending without a job id: the job is sent and named in the status
 * within milliseconds of the revision being marked queued, so an older one was marked by a
 * process that died before sending.
 */
export const UNSENT_AFTER_MS = 60_000;

/**
 * `derived.status` as a job wrote it, or the failure shown for one that cannot be read or whose
 * job ended without a result, so an editor is offered Retry. `jobState` is the pg-boss state of
 * the job the status names: a string, null when pg-boss has no such job, undefined when unknown.
 * A pending status that names no job after `UNSENT_AFTER_MS` was never sent and shows as failed.
 */
export function readDerivedStatus(
  raw: unknown,
  revisionCreatedAt: Date,
  jobState?: string | null,
  now = Date.now(),
): DerivedStatus | null {
  if (raw === undefined || raw === null) return null;
  const parsed = DerivedStatus.safeParse(raw);
  if (parsed.success) {
    const { state } = parsed.data;
    const pending = state === 'queued' || state === 'running';
    const ended = jobState !== undefined && !(jobState && LIVE_JOB_STATES.has(jobState));
    const unsent =
      parsed.data.jobId === null && now - Date.parse(parsed.data.updatedAt) > UNSENT_AFTER_MS;
    if (pending && (ended || unsent)) {
      return { ...parsed.data, state: 'failed', error: 'Processing stopped without a result' };
    }
    return parsed.data;
  }
  const job = (raw as { job?: unknown }).job;
  return {
    state: 'failed',
    job: typeof job === 'string' ? job : 'unknown',
    jobId: null,
    error: 'unreadable status',
    updatedAt: revisionCreatedAt.toISOString(),
  };
}
