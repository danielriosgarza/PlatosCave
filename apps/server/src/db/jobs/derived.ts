import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { CourseScope } from '../../auth/scope';
import { DerivedStatus, type ResourceJobStatus, readDerivedStatus } from '../../jobs/derived';
import type { Db } from '../client';
import { resourceRevisions, resources, topics } from '../schema';
import { forCourse } from '../scoped';

export type ResourceType = (typeof resources.$inferSelect)['type'];

/**
 * Identifies a recorded `derived.status` as read: md5 of its jsonb text, null when there is none
 * (no key, or JSON null). A conditional write compares it in SQL, so nothing round-trips.
 */
const statusTag = sql<
  string | null
>`md5(nullif(${resourceRevisions.derived} -> 'status', 'null'::jsonb)::text)`;

/**
 * The status a conditional write expects to replace: the one read with `tag` (null for none),
 * or one this process wrote itself.
 */
export type ExpectedStatus = { tag: string | null } | { written: DerivedStatus };

/**
 * Writes `derived.status` of one revision of the scope's course only if the recorded status is
 * still the expected one, in one statement, so of two callers acting on the same reading only
 * one moves it on. Returns false when the status has changed or the revision is not in the course.
 */
export async function claimDerivedStatus(
  db: Db,
  scope: CourseScope,
  revisionId: string,
  expected: ExpectedStatus,
  status: DerivedStatus,
): Promise<boolean> {
  const value = JSON.stringify(DerivedStatus.parse(status));
  const current =
    'tag' in expected
      ? sql`${statusTag} IS NOT DISTINCT FROM ${expected.tag}`
      : sql`${resourceRevisions.derived} -> 'status' = ${JSON.stringify(DerivedStatus.parse(expected.written))}::jsonb`;
  const rows = await db
    .update(resourceRevisions)
    .set({ derived: sql`jsonb_set(${resourceRevisions.derived}, '{status}', ${value}::jsonb)` })
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions), current))
    .returning({ id: resourceRevisions.id });
  return rows.length > 0;
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

/** Job status of each unarchived resource's head revision in the course's unarchived topics. */
export async function listResourceJobStatus(
  db: Db,
  scope: CourseScope,
  resourceId?: string,
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
      statusTag,
    })
    .from(resources)
    .innerJoin(topics, eq(topics.id, resources.topicId))
    .leftJoin(resourceRevisions, eq(resourceRevisions.id, resources.headRevisionId))
    .where(
      and(
        forCourse(scope, resources),
        isNull(resources.archivedAt),
        isNull(topics.archivedAt),
        ...(resourceId ? [eq(resources.id, resourceId)] : []),
      ),
    )
    .orderBy(asc(topics.position), asc(resources.position));
  return rows.map(({ status, revisionCreatedAt, ...row }) => ({
    ...row,
    status: revisionCreatedAt ? readDerivedStatus(status, revisionCreatedAt) : null,
  }));
}
