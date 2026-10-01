import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { resourceRevisions, resources, topics } from '../db/schema';
import { forCourse } from '../db/scoped';

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

/** The state a job recorded for a revision, or undefined when none was ever queued. */
export const derivedState = (
  derived: Record<string, unknown>,
): DerivedStatus['state'] | undefined =>
  derived.status === undefined
    ? undefined
    : (DerivedStatus.safeParse(derived.status).data?.state ?? 'failed');

/** Whether a revision of the scope's course has a recorded job status; false when it has none. */
export async function hasDerivedStatus(
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ status: sql<unknown>`${resourceRevisions.derived} -> 'status'` })
    .from(resourceRevisions)
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)));
  return row?.status !== undefined && row.status !== null;
}

/**
 * Writes `derived.status` of one revision of the scope's course, leaving other derived outputs
 * untouched. Returns false when no such revision exists in that course.
 */
export async function setDerivedStatus(
  db: Db,
  scope: CourseScope,
  revisionId: string,
  status: DerivedStatus,
): Promise<boolean> {
  const value = JSON.stringify(DerivedStatus.parse(status));
  const rows = await db
    .update(resourceRevisions)
    .set({ derived: sql`jsonb_set(${resourceRevisions.derived}, '{status}', ${value}::jsonb)` })
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)))
    .returning({ id: resourceRevisions.id });
  return rows.length > 0;
}

/** What a derivation job reads of a revision: its type, content and stored objects. */
export type DerivationSource = Pick<
  typeof resourceRevisions.$inferSelect,
  'type' | 'content' | 'objectKeys'
>;

/** The source of one revision of the scope's course, or null when it is not in that course. */
export async function loadDerivationSource(
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<DerivationSource | null> {
  const [row] = await db
    .select({
      type: resourceRevisions.type,
      content: resourceRevisions.content,
      objectKeys: resourceRevisions.objectKeys,
    })
    .from(resourceRevisions)
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)));
  return row ?? null;
}

/**
 * Merges a job's outputs and its final status into `derived` of one revision of the scope's
 * course, keeping other keys.
 */
export async function writeDerivedOutputs(
  db: Db,
  scope: CourseScope,
  revisionId: string,
  outputs: Record<string, unknown>,
  status: DerivedStatus,
): Promise<void> {
  const value = JSON.stringify({ ...outputs, status: DerivedStatus.parse(status) });
  await db
    .update(resourceRevisions)
    .set({ derived: sql`${resourceRevisions.derived} || ${value}::jsonb` })
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)));
}

export interface ResourceJobStatus {
  resourceId: string;
  topicId: string;
  title: string;
  type: (typeof resources.$inferSelect)['type'];
  revisionId: string | null;
  /**
   * Null when the head revision has no derived outputs to produce, or no revision exists. A
   * status that cannot be read shows as `failed`, so it never disappears from the view.
   */
  status: DerivedStatus | null;
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

/** Job status of each unarchived resource's head revision in the course's unarchived topics. */
export async function listResourceJobStatus(
  db: Db,
  scope: CourseScope,
): Promise<ResourceJobStatus[]> {
  const rows = await db
    .select({
      resourceId: resources.id,
      topicId: resources.topicId,
      title: resources.title,
      type: resources.type,
      revisionId: resources.headRevisionId,
      revisionCreatedAt: resourceRevisions.createdAt,
      status: sql<unknown>`${resourceRevisions.derived} -> 'status'`,
    })
    .from(resources)
    .innerJoin(topics, eq(topics.id, resources.topicId))
    .leftJoin(resourceRevisions, eq(resourceRevisions.id, resources.headRevisionId))
    .where(
      and(forCourse(scope, resources), isNull(resources.archivedAt), isNull(topics.archivedAt)),
    )
    .orderBy(asc(topics.position), asc(resources.position));
  return rows.map(({ status, revisionCreatedAt, ...row }) => ({
    ...row,
    status: revisionCreatedAt ? readDerivedStatus(status, revisionCreatedAt) : null,
  }));
}
