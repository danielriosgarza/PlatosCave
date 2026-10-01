import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CourseScope } from '../auth/scope';
import type { Db } from '../db/client';
import { resourceRevisions, resources, topics } from '../db/schema';
import { forCourse } from '../db/scoped';
import { BOSS_SCHEMA } from './boss';

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

/**
 * Which attempt may write: the write happens only while `derived.status.jobId` is `jobId`
 * (`null`: no job attached yet), or, with `orUnattached`, also while no job is attached. Two
 * jobs for one revision (a Retry sent while an attempt still runs) thus cannot overwrite each
 * other's status: the job named in the status owns it.
 */
export interface StatusGuard {
  jobId?: string | null;
  orUnattached?: boolean;
  /** Writes only to revisions of these types, so one job never touches another's status. */
  types?: readonly (typeof resourceRevisions.$inferSelect)['type'][];
}

const currentJobId = sql`${resourceRevisions.derived} -> 'status' ->> 'jobId'`;

function guardCondition(guard: StatusGuard | undefined) {
  if (!guard) return undefined;
  const types = guard.types ? inArray(resourceRevisions.type, [...guard.types]) : undefined;
  if (guard.jobId === undefined) return types;
  const owner =
    guard.jobId === null
      ? sql`${currentJobId} IS NULL`
      : guard.orUnattached
        ? sql`(${currentJobId} IS NULL OR ${currentJobId} = ${guard.jobId})`
        : sql`${currentJobId} = ${guard.jobId}`;
  return and(owner, types);
}

/**
 * Writes `derived.status` of one revision of the scope's course, leaving other derived outputs
 * untouched. Returns false when no such revision exists in that course, or `guard` refuses.
 */
export async function setDerivedStatus(
  db: Db,
  scope: CourseScope,
  revisionId: string,
  status: DerivedStatus,
  guard?: StatusGuard,
): Promise<boolean> {
  const value = JSON.stringify(DerivedStatus.parse(status));
  const rows = await db
    .update(resourceRevisions)
    .set({ derived: sql`jsonb_set(${resourceRevisions.derived}, '{status}', ${value}::jsonb)` })
    .where(
      and(
        eq(resourceRevisions.id, revisionId),
        forCourse(scope, resourceRevisions),
        guardCondition(guard),
      ),
    )
    .returning({ id: resourceRevisions.id });
  return rows.length > 0;
}

/** `derived.status` of one revision of the scope's course as stored (not validated), if any. */
export async function readStatus(db: Db, scope: CourseScope, revisionId: string): Promise<unknown> {
  const [row] = await db
    .select({ status: sql<unknown>`${resourceRevisions.derived} -> 'status'` })
    .from(resourceRevisions)
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)));
  return row?.status ?? null;
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
 * course, keeping other keys. Returns false when nothing was written (no such revision, or
 * `guard` refuses).
 */
export async function writeDerivedOutputs(
  db: Db,
  scope: CourseScope,
  revisionId: string,
  outputs: Record<string, unknown>,
  status: DerivedStatus,
  guard?: StatusGuard,
): Promise<boolean> {
  const value = JSON.stringify({ ...outputs, status: DerivedStatus.parse(status) });
  const rows = await db
    .update(resourceRevisions)
    .set({ derived: sql`${resourceRevisions.derived} || ${value}::jsonb` })
    .where(
      and(
        eq(resourceRevisions.id, revisionId),
        forCourse(scope, resourceRevisions),
        guardCondition(guard),
      ),
    )
    .returning({ id: resourceRevisions.id });
  return rows.length > 0;
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

/**
 * pg-boss states in which a job may still write its status; any other state, or no job row at
 * all, means it ended without writing (refused, dead-lettered, expired past its retries, or
 * deleted by retention).
 */
const LIVE_JOB_STATES = new Set(['created', 'retry', 'active']);

/**
 * `derived.status` as a job wrote it, or the failure shown for one that cannot be read or whose
 * job ended without a result, so an editor is offered Retry. `jobState` is the pg-boss state of
 * the job the status names: a string, null when pg-boss has no such job, undefined when unknown.
 */
export function readDerivedStatus(
  raw: unknown,
  revisionCreatedAt: Date,
  jobState?: string | null,
): DerivedStatus | null {
  if (raw === undefined || raw === null) return null;
  const parsed = DerivedStatus.safeParse(raw);
  if (parsed.success) {
    const { state } = parsed.data;
    const pending = state === 'queued' || state === 'running';
    if (pending && jobState !== undefined && !(jobState && LIVE_JOB_STATES.has(jobState))) {
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
  const pendingJobs = rows.flatMap(({ status }) => {
    const parsed = DerivedStatus.safeParse(status);
    const pending = parsed.data?.state === 'queued' || parsed.data?.state === 'running';
    return pending && parsed.data?.jobId ? [parsed.data.jobId] : [];
  });
  const states = await jobStates(db, pendingJobs);
  return rows.map(({ status, revisionCreatedAt, ...row }) => {
    const jobId = DerivedStatus.safeParse(status).data?.jobId;
    const jobState = states && jobId && isUuid(jobId) ? (states.get(jobId) ?? null) : undefined;
    return {
      ...row,
      status: revisionCreatedAt ? readDerivedStatus(status, revisionCreatedAt, jobState) : null,
    };
  });
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * pg-boss's state of each of these jobs (ids it has no row for are absent), or null when its
 * tables do not exist (pg-boss never started on this database), so nothing can be concluded.
 */
async function jobStates(db: Db, jobIds: string[]): Promise<Map<string, string> | null> {
  const ids = [...new Set(jobIds.filter(isUuid))];
  if (ids.length === 0) return new Map();
  const table = `${BOSS_SCHEMA}.job`;
  const { rows: found } = await db.execute<{ exists: boolean }>(
    sql`select to_regclass(${table}) is not null as exists`,
  );
  if (!found[0]?.exists) return null;
  const { rows } = await db.execute<{ id: string; state: string }>(
    sql`select id::text as id, state::text as state from ${sql.raw(table)}
        where id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.id, r.state]));
}
