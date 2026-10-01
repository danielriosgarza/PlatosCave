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

export interface ResourceJobStatus {
  resourceId: string;
  topicId: string;
  title: string;
  type: (typeof resources.$inferSelect)['type'];
  revisionId: string | null;
  /** Null when the head revision has no derived outputs to produce, or no revision exists. */
  status: DerivedStatus | null;
}

/** Job status of every unarchived draft resource's head revision in the scope's course. */
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
      status: sql<unknown>`${resourceRevisions.derived} -> 'status'`,
    })
    .from(resources)
    .innerJoin(topics, eq(topics.id, resources.topicId))
    .leftJoin(resourceRevisions, eq(resourceRevisions.id, resources.headRevisionId))
    .where(and(forCourse(scope, resources), isNull(resources.archivedAt)))
    .orderBy(asc(topics.position), asc(resources.position));
  return rows.map(({ status, ...row }) => {
    const parsed = DerivedStatus.safeParse(status);
    return { ...row, status: parsed.success ? parsed.data : null };
  });
}
