import type { ResourceType } from '@parallax/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CourseScope } from '../../auth/scope';
import type { Db } from '../client';
import { resourceRevisions, resources, topics } from '../schema';
import { forCourse } from '../scoped';
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

/**
 * Identifies a recorded `derived.status` as read: md5 of its jsonb text, null when there is none
 * (no key, or JSON null). A guarded write compares it in SQL, so nothing round-trips through JS.
 */
const statusTag = sql<
  string | null
>`md5(nullif(${resourceRevisions.derived} -> 'status', 'null'::jsonb)::text)`;

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
  types?: readonly ResourceType[];
  /**
   * Writes only while the status is still the one read with this tag (`statusTag`; null: no
   * status), so of two callers acting on what they read, one moves the status on.
   */
  tag?: string | null;
}

const currentJobId = sql`${resourceRevisions.derived} -> 'status' ->> 'jobId'`;

function guardCondition(guard: StatusGuard | undefined) {
  if (!guard) return undefined;
  const types = and(
    guard.types ? inArray(resourceRevisions.type, [...guard.types]) : undefined,
    guard.tag === undefined ? undefined : sql`${statusTag} IS NOT DISTINCT FROM ${guard.tag}`,
  );
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

/**
 * `derived.status` of one revision of the scope's course as stored (not validated), with its
 * `tag`; null when there is no such revision.
 */
export async function readStatus(
  db: Db,
  scope: CourseScope,
  revisionId: string,
): Promise<{ raw: unknown; tag: string | null } | null> {
  const [row] = await db
    .select({ raw: sql<unknown>`${resourceRevisions.derived} -> 'status'`, tag: statusTag })
    .from(resourceRevisions)
    .where(and(eq(resourceRevisions.id, revisionId), forCourse(scope, resourceRevisions)));
  return row ? { raw: row.raw ?? null, tag: row.tag } : null;
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
