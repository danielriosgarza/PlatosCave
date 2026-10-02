import type { ResourceType } from '@parallax/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CourseScope } from '../../auth/scope';
import { DerivedStatus, type ResourceJobStatus, readDerivedStatus } from '../../jobs/derived';
import type { Db } from '../client';
import { resourceRevisions, resources, topics } from '../schema';
import { forCourse } from '../scoped';
import { BOSS_SCHEMA } from './boss';

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
  const statuses = await resolveDerivedStatuses(
    db,
    rows.map(({ status, revisionCreatedAt }) => ({ raw: status, createdAt: revisionCreatedAt })),
  );
  return rows.map(({ status: _raw, revisionCreatedAt: _createdAt, ...row }, i) => ({
    ...row,
    status: statuses[i] ?? null,
  }));
}

/** A revision's recorded `derived.status` (not validated) and when the revision was created. */
export interface RecordedStatus {
  raw: unknown;
  /** Null when there is no revision: its status is then null too. */
  createdAt: Date | null;
}

/**
 * The status of each revision as every view shows it (`readDerivedStatus`), with each pending
 * status checked against the pg-boss state of the job it names: one that ended without writing
 * shows as failed. The processing list, release validation and the reader all read statuses
 * through here, so they never disagree about a job that stopped. One query for all pending jobs.
 */
export async function resolveDerivedStatuses(
  db: Pick<Db, 'execute'>,
  recorded: readonly RecordedStatus[],
): Promise<(DerivedStatus | null)[]> {
  const parsed = recorded.map(({ raw }) => DerivedStatus.safeParse(raw).data);
  const pendingJobs = parsed.flatMap((written) =>
    (written?.state === 'queued' || written?.state === 'running') && written.jobId
      ? [written.jobId]
      : [],
  );
  const states = await jobStates(db, pendingJobs);
  return recorded.map(({ raw, createdAt }, i) => {
    if (!createdAt) return null;
    const jobId = parsed[i]?.jobId;
    const jobState = states && jobId && isUuid(jobId) ? (states.get(jobId) ?? null) : undefined;
    return readDerivedStatus(raw, createdAt, jobState);
  });
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * pg-boss's state of each of these jobs (ids it has no row for are absent), or null when its
 * tables do not exist (pg-boss never started on this database), so nothing can be concluded.
 */
async function jobStates(
  db: Pick<Db, 'execute'>,
  jobIds: string[],
): Promise<Map<string, string> | null> {
  const ids = [...new Set(jobIds.filter(isUuid))];
  if (ids.length === 0) return new Map();
  if (!(await bossTableExists(db))) return null;
  const { rows } = await db.execute<{ id: string; state: string }>(
    sql`select id::text as id, state::text as state from ${sql.raw(BOSS_JOB_TABLE)}
        where id = any(${sql.param(ids)}::uuid[])`,
  );
  return new Map(rows.map((r) => [r.id, r.state]));
}

const BOSS_JOB_TABLE = `${BOSS_SCHEMA}.job`;

/**
 * pg-boss's job table, once seen, stays: only a positive answer is remembered, per database
 * handle (a transaction is a new handle, so it probes again).
 */
const bossTableSeen = new WeakSet<object>();
async function bossTableExists(db: Pick<Db, 'execute'>): Promise<boolean> {
  if (bossTableSeen.has(db)) return true;
  const { rows } = await db.execute<{ exists: boolean }>(
    sql`select to_regclass(${BOSS_JOB_TABLE}) is not null as exists`,
  );
  if (!rows[0]?.exists) return false;
  bossTableSeen.add(db);
  return true;
}
