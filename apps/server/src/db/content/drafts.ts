import { createHash } from 'node:crypto';
import { exerciseProblems, shinyContentProblem } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/drafts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { CourseScope } from '../../auth/scope';
import { invalid, notFound, type Outcome } from '../../outcome';
import type { Db } from '../client';
import { derivedReady } from '../jobs/derived';
import { resourceRevisions, resources, storageObjects, topics } from '../schema';
import { forCourse } from '../scoped';

/**
 * Draft topics and resources of one course (§12, ADR-0003). Every function takes a resolved
 * `CourseScope`, so rows of another course are unreachable. Drafts are mutable; each mutation
 * checks the caller's `expectedRevision` and increments `revision`. Content lives in immutable
 * `resource_revisions`; nothing here reads or writes releases, so drafts never reach a class.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Topic = z.input<typeof contracts.draftTopic>;
type ResourceSummary = z.input<typeof contracts.draftResourceSummary>;
type Resource = z.input<typeof contracts.draftResource>;
type TopicRow = typeof topics.$inferSelect;
type ResourceRow = typeof resources.$inferSelect;
type RevisionRow = typeof resourceRevisions.$inferSelect;
type Json = Record<string, unknown>;

const toTopic = (row: TopicRow): Topic => ({
  id: row.id,
  courseId: row.courseId,
  position: row.position,
  title: row.title,
  objective: row.objective,
  prerequisites: row.prerequisites,
  completionRule: row.completionRule ?? null,
  estimatedMinutes: row.estimatedMinutes,
  revision: row.revision,
  archived: row.archivedAt !== null,
  updatedAt: row.updatedAt.toISOString(),
});

const toSummary = (row: ResourceRow): ResourceSummary => ({
  id: row.id,
  courseId: row.courseId,
  topicId: row.topicId,
  type: row.type,
  title: row.title,
  position: row.position,
  visibility: row.visibility,
  releaseAt: row.releaseAt?.toISOString() ?? null,
  headRevisionId: row.headRevisionId,
  revision: row.revision,
  archived: row.archivedAt !== null,
  updatedAt: row.updatedAt.toISOString(),
});

const toResource = (row: ResourceRow, head: RevisionRow | undefined): Resource => ({
  ...toSummary(row),
  head: head
    ? {
        id: head.id,
        content: head.content,
        objectKeys: head.objectKeys,
        accessibleAlternative: head.accessibleAlternative ?? null,
        provenance: head.provenance ?? null,
        contentHash: head.contentHash,
        createdBy: head.createdBy,
        createdAt: head.createdAt.toISOString(),
      }
    : null,
});

/**
 * Why `content` is not valid for a resource of `type`; exercises must be `exercise.v1` (§9) and
 * a Shiny app needs a usable address (§10.7).
 */
function contentProblem(type: string, content: unknown): string | undefined {
  if (type === 'shiny') return shinyContentProblem(content);
  if (type !== 'exercise') return undefined;
  const [problem] = exerciseProblems(content);
  return problem && `exercise.v1 ${problem}`;
}

/** JSON with object keys sorted, so equal content always hashes equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface RevisionPayload {
  content: Json;
  objectKeys: string[];
  accessibleAlternative: Json | null;
  provenance: Json | null;
}

/** sha256 over everything a revision stores; equal hash means "unchanged content". */
export const revisionHash = (type: string, p: RevisionPayload): string =>
  createHash('sha256')
    .update(canonical({ type, ...p }))
    .digest('hex');

/** Object keys must name objects this course already stored (no foreign or invented keys). */
async function checkObjectKeys(tx: Tx, scope: CourseScope, keys: string[]): Promise<boolean> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return true;
  const rows = await tx
    .select({ key: storageObjects.key })
    .from(storageObjects)
    .where(and(forCourse(scope, storageObjects), inArray(storageObjects.key, unique)));
  return rows.length === unique.length;
}

/**
 * The head's finished derived outputs, when the new revision has the same source: processing
 * reads only `content` and `objectKeys` (and the resource type, which never changes), so an
 * edit of the alternative or provenance alone reuses them instead of queuing the job again.
 * Unfinished or failed work is not carried: a pending status names a job bound to the old
 * revision, so the new one is processed afresh.
 */
function kept(head: RevisionRow | undefined, next: RevisionPayload): Json | undefined {
  if (!head || !derivedReady(head.derived)) return undefined;
  const sameSource =
    canonical(head.content) === canonical(next.content) &&
    canonical(head.objectKeys) === canonical(next.objectKeys);
  return sameSource ? head.derived : undefined;
}

async function insertRevision(
  tx: Tx,
  scope: CourseScope,
  resource: { id: string; type: ResourceRow['type'] },
  payload: RevisionPayload,
  hash: string,
  now: Date,
  derived?: Json,
): Promise<RevisionRow> {
  const [row] = await tx
    .insert(resourceRevisions)
    .values({
      resourceId: resource.id,
      courseId: scope.courseId,
      type: resource.type,
      ...payload,
      ...(derived && { derived }),
      contentHash: hash,
      createdBy: scope.user.id,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error('revision insert returned no row');
  return row;
}

const findTopic = async (db: Db | Tx, scope: CourseScope, topicId: string) =>
  (
    await db
      .select()
      .from(topics)
      .where(and(forCourse(scope, topics), eq(topics.id, topicId)))
  )[0];

async function loadResource(
  db: Db | Tx,
  scope: CourseScope,
  resourceId: string,
  lock = false,
): Promise<{ row: ResourceRow; head: RevisionRow | undefined } | undefined> {
  const query = db
    .select()
    .from(resources)
    .where(and(forCourse(scope, resources), eq(resources.id, resourceId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) return undefined;
  if (!row.headRevisionId) return { row, head: undefined };
  const [head] = await db
    .select()
    .from(resourceRevisions)
    .where(and(forCourse(scope, resourceRevisions), eq(resourceRevisions.id, row.headRevisionId)));
  return { row, head };
}

/** Archiving keeps the first archive time; restoring clears it. */
const archivedAt = (column: typeof topics.archivedAt | typeof resources.archivedAt, now: Date) =>
  sql`coalesce(${column}, ${now.toISOString()}::timestamptz)`;

export async function listDrafts(db: Db, scope: CourseScope) {
  const topicRows = await db
    .select()
    .from(topics)
    .where(forCourse(scope, topics))
    .orderBy(asc(topics.position), asc(topics.createdAt), asc(topics.id));
  const resourceRows = await db
    .select()
    .from(resources)
    .where(forCourse(scope, resources))
    .orderBy(asc(resources.position), asc(resources.createdAt), asc(resources.id));
  return {
    topics: topicRows.map((t) => ({
      ...toTopic(t),
      resources: resourceRows.filter((r) => r.topicId === t.id).map(toSummary),
    })),
  };
}

export async function createTopic(
  db: Db,
  scope: CourseScope,
  input: z.output<NonNullable<(typeof contracts.createTopic)['body']>>,
  now: Date,
): Promise<Topic> {
  const [row] = await db
    .insert(topics)
    .values({
      courseId: scope.courseId,
      position:
        input.position ??
        sql`(select coalesce(max(${topics.position}) + 1, 0) from ${topics} where ${forCourse(scope, topics)})`,
      title: input.title,
      objective: input.objective ?? '',
      prerequisites: input.prerequisites ?? [],
      completionRule: input.completionRule ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      createdBy: scope.user.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('topic insert returned no row');
  return toTopic(row);
}

export async function updateTopic(
  db: Db,
  scope: CourseScope,
  topicId: string,
  input: z.output<NonNullable<(typeof contracts.updateTopic)['body']>>,
  now: Date,
): Promise<Outcome<Topic>> {
  const { expectedRevision, archived, ...fields } = input;
  // One conditional UPDATE: two editors with the same expectedRevision cannot both succeed.
  const [row] = await db
    .update(topics)
    .set({
      ...fields,
      ...(archived !== undefined && {
        archivedAt: archived ? archivedAt(topics.archivedAt, now) : null,
      }),
      revision: sql`${topics.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(forCourse(scope, topics), eq(topics.id, topicId), eq(topics.revision, expectedRevision)),
    )
    .returning();
  if (row) return { ok: true, value: toTopic(row) };
  const current = await findTopic(db, scope, topicId);
  return current ? { ok: false, reason: 'conflict', current: toTopic(current) } : notFound;
}

export async function createResource(
  db: Db,
  scope: CourseScope,
  topicId: string,
  input: z.output<NonNullable<(typeof contracts.createResource)['body']>>,
  now: Date,
): Promise<Outcome<Resource>> {
  return db.transaction(async (tx) => {
    if (!(await findTopic(tx, scope, topicId))) return notFound;
    const { content, objectKeys = [], accessibleAlternative = null, provenance = null } = input;
    if (content === undefined && (objectKeys.length || accessibleAlternative || provenance)) {
      return invalid('content is required with object keys, alternative or provenance');
    }
    if (!(await checkObjectKeys(tx, scope, objectKeys))) {
      return invalid('object keys must name objects stored in this course');
    }
    const problem = content === undefined ? undefined : contentProblem(input.type, content);
    if (problem) return invalid(problem);
    const [row] = await tx
      .insert(resources)
      .values({
        courseId: scope.courseId,
        topicId,
        type: input.type,
        title: input.title,
        position:
          input.position ??
          sql`(select coalesce(max(${resources.position}) + 1, 0) from ${resources} where ${and(forCourse(scope, resources), eq(resources.topicId, topicId))})`,
        visibility: input.visibility ?? 'visible',
        releaseAt: input.releaseAt ? new Date(input.releaseAt) : null,
        createdBy: scope.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('resource insert returned no row');
    if (content === undefined) return { ok: true, value: toResource(row, undefined) };

    const payload = { content, objectKeys, accessibleAlternative, provenance };
    const head = await insertRevision(
      tx,
      scope,
      row,
      payload,
      revisionHash(row.type, payload),
      now,
    );
    const [withHead] = await tx
      .update(resources)
      .set({ headRevisionId: head.id })
      .where(and(forCourse(scope, resources), eq(resources.id, row.id)))
      .returning();
    if (!withHead) throw new Error('resource update returned no row');
    return { ok: true, value: toResource(withHead, head) };
  });
}

export async function getResource(
  db: Db,
  scope: CourseScope,
  resourceId: string,
): Promise<Resource | undefined> {
  const found = await loadResource(db, scope, resourceId);
  return found && toResource(found.row, found.head);
}

export async function updateResource(
  db: Db,
  scope: CourseScope,
  resourceId: string,
  input: z.output<NonNullable<(typeof contracts.updateResource)['body']>>,
  now: Date,
): Promise<Outcome<Resource>> {
  return db.transaction(async (tx) => {
    // The row lock serialises concurrent edits, so the revision check below cannot race.
    const found = await loadResource(tx, scope, resourceId, true);
    if (!found) return notFound;
    const { row, head } = found;
    if (row.revision !== input.expectedRevision) {
      return { ok: false, reason: 'conflict', current: toResource(row, head) };
    }
    const { content, objectKeys, accessibleAlternative, provenance } = input;
    if (input.topicId !== undefined && !(await findTopic(tx, scope, input.topicId))) {
      return notFound;
    }

    let newHead: RevisionRow | undefined;
    const touchesRevision = [content, objectKeys, accessibleAlternative, provenance].some(
      (v) => v !== undefined,
    );
    if (touchesRevision) {
      const nextContent = content ?? head?.content;
      if (nextContent === undefined) {
        return invalid('content is required for the first revision');
      }
      const problem = content === undefined ? undefined : contentProblem(row.type, content);
      if (problem) return invalid(problem);
      const payload: RevisionPayload = {
        content: nextContent,
        objectKeys: objectKeys ?? head?.objectKeys ?? [],
        accessibleAlternative:
          accessibleAlternative !== undefined
            ? accessibleAlternative
            : (head?.accessibleAlternative ?? null),
        provenance: provenance !== undefined ? provenance : (head?.provenance ?? null),
      };
      if (objectKeys && !(await checkObjectKeys(tx, scope, objectKeys))) {
        return invalid('object keys must name objects stored in this course');
      }
      const hash = revisionHash(row.type, payload);
      // Same content hash as the head: nothing new to record, the head stays.
      if (hash !== head?.contentHash) {
        newHead = await insertRevision(tx, scope, row, payload, hash, now, kept(head, payload));
      }
    }

    const [updated] = await tx
      .update(resources)
      .set({
        ...(input.topicId !== undefined && { topicId: input.topicId }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.position !== undefined && { position: input.position }),
        ...(input.visibility !== undefined && { visibility: input.visibility }),
        ...(input.releaseAt !== undefined && {
          releaseAt: input.releaseAt ? new Date(input.releaseAt) : null,
        }),
        ...(input.archived !== undefined && {
          archivedAt: input.archived ? archivedAt(resources.archivedAt, now) : null,
        }),
        ...(newHead && { headRevisionId: newHead.id }),
        revision: sql`${resources.revision} + 1`,
        updatedAt: now,
      })
      .where(and(forCourse(scope, resources), eq(resources.id, row.id)))
      .returning();
    if (!updated) throw new Error('resource update returned no row');
    return { ok: true, value: toResource(updated, newHead ?? head) };
  });
}
