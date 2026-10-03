import { exerciseCredit, exerciseProblems, type ResourceType } from '@parallax/contracts';
import type { validationIssue, validationReport } from '@parallax/contracts/routes/releases';
import { and, asc, eq, isNull, lte, max, ne, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  type ClassScope,
  type CourseScope,
  type DraftPreviewScope,
  isDraftPreview,
} from '../../auth/scope';
import { openToStudent } from '../../content/availability';
import type { Db } from '../client';
import { derivedReady, resolveDerivedStatuses } from '../jobs/derived';
import {
  auditEvents,
  courseReleases,
  courses,
  releaseResources,
  releaseTopics,
  resourceRevisions,
  resources,
  topics,
} from '../schema';
import { forCourse, forDraftCourse } from '../scoped';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Issue = z.infer<typeof validationIssue>;
export type ValidationReport = z.infer<typeof validationReport>;
type Tab = (typeof releaseResources.$inferInsert)['tab'];

/**
 * The credit an exercise revision declares (§9), read from its content without loading the
 * rest of it; null for ungraded practice, other resource types and unreadable values.
 */
const creditColumn = sql<unknown>`case when ${resourceRevisions.type} = 'exercise' then ${resourceRevisions.content} -> 'credit' end`;
const creditOf = (raw: unknown) => {
  const parsed = exerciseCredit.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Destination tab of each resource type (§5). */
export const tabOf: Record<ResourceType, Tab> = {
  slides_pdf: 'slides',
  slides_web: 'slides',
  reading_native: 'reading',
  reading_pdf: 'reading',
  exercise: 'exercises',
  notebook: 'notebooks',
  shiny: 'notebooks',
  test: 'tests',
};

/** Types whose material is not text, so they need an accessible alternative (§7, §14). */
const needsAlternative = new Set<ResourceType>(['slides_pdf', 'reading_pdf', 'shiny']);

/**
 * The course's live (not archived) draft topics with their resources, head revisions and each
 * head revision's derived status as the processing list shows it (`resolveDerivedStatuses`).
 */
async function loadDrafts(tx: Tx, scope: CourseScope) {
  const topicRows = await tx
    .select()
    .from(topics)
    .where(and(forCourse(scope, topics), isNull(topics.archivedAt)))
    .orderBy(asc(topics.position), asc(topics.createdAt));
  const resourceRows = await tx
    .select({ resource: resources, revision: resourceRevisions })
    .from(resources)
    .leftJoin(resourceRevisions, eq(resourceRevisions.id, resources.headRevisionId))
    .where(and(forCourse(scope, resources), isNull(resources.archivedAt)))
    .orderBy(asc(resources.position), asc(resources.createdAt));
  const statuses = await resolveDerivedStatuses(
    tx,
    resourceRows.map(({ revision }) => ({
      raw: revision?.derived.status,
      createdAt: revision?.createdAt ?? null,
    })),
  );
  const withStatus = resourceRows.map((row, i) => ({ ...row, status: statuses[i] ?? null }));
  return topicRows.map((topic) => ({
    topic,
    resources: withStatus.filter((r) => r.resource.topicId === topic.id),
  }));
}
type Drafts = Awaited<ReturnType<typeof loadDrafts>>;

/**
 * Publication checks (§12, ADR-0003): broken references, missing alternatives and unconverted
 * decks. Grading-rule and execution-configuration checks join this function with the items
 * that define those resource contents (P2-10, P3-15).
 */
export function validate(drafts: Drafts): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (drafts.length === 0) {
    errors.push({
      code: 'empty_release',
      message: 'The course has no topics to publish',
    });
  }
  const topicIds = new Set(drafts.map((d) => d.topic.id));
  for (const { topic, resources: items } of drafts) {
    const topicId = topic.id;
    for (const prerequisite of topic.prerequisites) {
      if (!topicIds.has(prerequisite)) {
        errors.push({
          code: 'broken_reference',
          message: `“${topic.title}” requires a topic that is not in this release`,
          topicId,
        });
      }
    }
    if (items.length === 0) {
      warnings.push({
        code: 'empty_topic',
        message: `“${topic.title}” has no resources`,
        topicId,
      });
    }
    for (const { resource, revision, status } of items) {
      const at = { topicId, resourceId: resource.id };
      if (!revision) {
        errors.push({
          code: 'no_revision',
          message: `“${resource.title}” has no content`,
          ...at,
        });
        continue;
      }
      // Nothing in the schema ties a head revision to its resource; the immutability
      // triggers would make a wrong pin permanent, so check before snapshotting.
      if (revision.resourceId !== resource.id || revision.courseId !== resource.courseId) {
        errors.push({
          code: 'broken_reference',
          message: `“${resource.title}” points at another resource’s revision`,
          ...at,
        });
        continue;
      }
      // The release tab comes from the revision type, so a mismatch would pin it in the wrong tab.
      if (revision.type !== resource.type) {
        errors.push({
          code: 'broken_reference',
          message: `“${resource.title}” has content of another resource type`,
          ...at,
        });
        continue;
      }
      if (revision.type === 'slides_pdf' && !derivedReady(revision.derived)) {
        const failed = status?.state === 'failed';
        errors.push({
          code: 'unconverted_deck',
          message: failed
            ? `“${resource.title}” could not be processed; upload it again or retry`
            : `“${resource.title}” has not been converted for viewing`,
          ...at,
        });
      }
      if (
        revision.type === 'reading_native' ||
        revision.type === 'reading_pdf' ||
        revision.type === 'notebook'
      ) {
        // A reading or notebook nobody can open is worse than none: block while its job is
        // unfinished or failed. A revision with no job on record (older data) is left alone.
        const state = status?.state;
        if (state !== undefined && state !== 'ready') {
          errors.push({
            code: 'unprocessed_reading',
            message:
              state === 'failed'
                ? `“${resource.title}” could not be processed; upload it again or retry`
                : `“${resource.title}” is still being processed`,
            ...at,
          });
        }
      }
      if (revision.type === 'exercise') {
        for (const problem of exerciseProblems(revision.content)) {
          errors.push({
            code: 'invalid_exercise',
            message: `“${resource.title}”: ${problem}`,
            ...at,
          });
        }
      }
      if (needsAlternative.has(revision.type) && !revision.accessibleAlternative) {
        const rasterDeck = revision.type === 'slides_pdf' && revision.derived.rasterOnly === true;
        (rasterDeck ? errors : warnings).push({
          code: 'missing_alternative',
          message: `“${resource.title}” has no accessible alternative`,
          ...at,
        });
      }
    }
  }
  return { errors, warnings };
}

export function validateDrafts(db: Db, scope: CourseScope): Promise<ValidationReport> {
  return db.transaction(async (tx) => validate(await loadDrafts(tx, scope)));
}

export type PublishResult =
  | {
      ok: true;
      release: typeof courseReleases.$inferSelect;
      report: ValidationReport;
    }
  | { ok: false; report: ValidationReport };

/**
 * Validates the drafts and, when nothing blocks, snapshots them as the course's next release
 * (ADR-0003). The course row lock serialises concurrent publishes of one course.
 */
export function publishRelease(
  db: Db,
  scope: CourseScope,
  opts: { id?: string } = {},
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.id, scope.courseId))
      .for('update');
    const drafts = await loadDrafts(tx, scope);
    const report = validate(drafts);
    if (report.errors.length > 0) return { ok: false, report };

    const [last] = await tx
      .select({ version: max(courseReleases.version) })
      .from(courseReleases)
      .where(forCourse(scope, courseReleases));
    const [release] = await tx
      .insert(courseReleases)
      .values({
        id: opts.id,
        courseId: scope.courseId,
        version: (last?.version ?? 0) + 1,
        validationReport: report,
        createdBy: scope.user.id,
      })
      .returning();
    if (!release) throw new Error('release insert returned no row');

    let resourceCount = 0;
    for (const { topic, resources: items } of drafts) {
      const [releaseTopic] = await tx
        .insert(releaseTopics)
        .values({
          releaseId: release.id,
          topicId: topic.id,
          position: topic.position,
          title: topic.title,
          objective: topic.objective,
          prerequisites: topic.prerequisites,
          completionRule: topic.completionRule,
          estimatedMinutes: topic.estimatedMinutes,
        })
        .returning({ id: releaseTopics.id });
      if (!releaseTopic) throw new Error('release topic insert returned no row');
      const rows = items.map(({ resource, revision }) => {
        // validate() has rejected these already; the guard keeps a bad row out of the snapshot.
        if (!revision || revision.resourceId !== resource.id || topic.courseId !== scope.courseId)
          throw new Error(`resource ${resource.id} failed its publish check`);
        return {
          releaseId: release.id,
          releaseTopicId: releaseTopic.id,
          resourceId: resource.id,
          resourceRevisionId: revision.id,
          tab: tabOf[revision.type],
          position: resource.position,
          title: resource.title,
          visibility: resource.visibility,
          releaseAt: resource.releaseAt,
        };
      });
      if (rows.length > 0) await tx.insert(releaseResources).values(rows);
      resourceCount += rows.length;
    }

    await tx.insert(auditEvents).values({
      actorId: scope.user.id,
      action: 'release.publish',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'course_release',
      targetId: release.id,
      after: {
        version: release.version,
        topics: drafts.length,
        resources: resourceCount,
        warnings: report.warnings.length,
      },
    });
    return { ok: true, release, report };
  });
}

/** Release resources the caller may study: students never see hidden ones (A26). */
export const studyVisible = (scope: ClassScope): SQL =>
  scope.role === 'student' ? ne(releaseResources.visibility, 'hidden') : sql`true`;

/**
 * Release resources the caller may study at `now`: students only once a resource is not hidden
 * and its release time has passed (§4, A26). Instructors study everything in the release.
 */
export const studyOpen = (scope: ClassScope, now: Date): SQL =>
  scope.role === 'student'
    ? (and(
        ne(releaseResources.visibility, 'hidden'),
        or(isNull(releaseResources.releaseAt), lte(releaseResources.releaseAt, now)),
      ) as SQL)
    : sql`true`;

/**
 * `release_resources` rows of the class's adopted release, which must be a release of the
 * class's own course, that the caller may study at `now`. False when the class has adopted
 * nothing.
 */
export function studyableRows(scope: ClassScope, now: Date): SQL {
  // A draft preview studies the course draft, never the release the class adopted.
  if (!scope.releaseId || scope.membership.isPreview) return sql`false`;
  const ofCourse = sql`exists (select 1 from ${courseReleases} where ${courseReleases.id} = ${releaseResources.releaseId} and ${courseReleases.courseId} = ${scope.courseId})`;
  return and(
    eq(releaseResources.releaseId, scope.releaseId),
    ofCourse,
    studyOpen(scope, now),
  ) as SQL;
}

/**
 * The pinned revision (id and type) of draft resource `resourceId` in the release the class
 * adopted, if the caller may study it at `now`; undefined otherwise, including for drafts.
 */
export async function studyableResource(
  db: Db | Tx,
  scope: ClassScope,
  resourceId: string,
  now: Date,
) {
  if (isDraftPreview(scope)) {
    const found = (await studyableDraft(db, scope, now)).find((r) => r.resourceId === resourceId);
    return found && { revisionId: found.revisionId, type: found.type };
  }
  if (!scope.releaseId) return undefined;
  const [row] = await db
    .select({
      revisionId: releaseResources.resourceRevisionId,
      type: resourceRevisions.type,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(and(studyableRows(scope, now), eq(releaseResources.resourceId, resourceId)));
  return row;
}

/**
 * The class's adopted release: the only path from a class to content (ADR-0003, A26). It reads
 * `class → release → release_resources → resource_revisions` and never touches draft rows,
 * except for a draft preview, which reads `draftSnapshot` instead. Students (and preview
 * principals) do not see hidden resources.
 */
export async function readClassRelease(db: Db, scope: ClassScope) {
  if (isDraftPreview(scope)) {
    const draft = await draftSnapshot(db, scope);
    const visible = draft.resources.filter(
      (r) => scope.role !== 'student' || r.visibility !== 'hidden',
    );
    return {
      release: null,
      topics: draft.topics.map((t) => ({
        ...t,
        resources: visible.filter((r) => r.releaseTopicId === t.id),
      })),
    };
  }
  if (!scope.releaseId) return { release: null, topics: [] };
  const [release] = await db
    .select()
    .from(courseReleases)
    .where(
      and(eq(courseReleases.id, scope.releaseId), eq(courseReleases.courseId, scope.courseId)),
    );
  if (!release) return { release: null, topics: [] };
  const topicRows = await db
    .select()
    .from(releaseTopics)
    .where(eq(releaseTopics.releaseId, release.id))
    .orderBy(asc(releaseTopics.position));
  const resourceRows = await db
    .select({ item: releaseResources, type: resourceRevisions.type, credit: creditColumn })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(and(eq(releaseResources.releaseId, release.id), studyVisible(scope)))
    .orderBy(asc(releaseResources.position));
  return {
    release,
    topics: topicRows.map((t) => ({
      ...t,
      resources: resourceRows
        .filter((r) => r.item.releaseTopicId === t.id)
        .map(({ item, type, credit }) => ({
          ...item,
          revisionId: item.resourceRevisionId,
          type,
          credit: creditOf(credit),
        })),
    })),
  };
}

/**
 * What a draft preview studies (ADR-0002, ADR-0003): the snapshot `publishRelease` would take
 * now, shaped like the rows of a release, built from the head revisions (immutable rows) of the
 * live draft. Only preview principals read it, after the resolver checked that their owner
 * still edits the course; real members always read the adopted release, and any other scope
 * gets the empty snapshot. Reads the syllabus columns and an exercise's declared credit, never other revision content. A resource
 * is left out unless its head revision passes publication's guard (same resource, course and
 * type), and so is anything in an archived topic.
 */
export async function draftSnapshot(db: Db | Tx, scope: DraftPreviewScope): Promise<DraftSnapshot> {
  // Guarded at run time too: no class read may serve drafts to a real member.
  if (!isDraftPreview(scope)) return { topics: [], resources: [] };
  return loadSnapshot(db, scope);
}

async function loadSnapshot(db: Db | Tx, scope: DraftPreviewScope) {
  const topicRows = await db
    .select({
      /** Plays the `release_topics` id: the draft topic id, stable for the snapshot. */
      id: topics.id,
      topicId: topics.id,
      position: topics.position,
      title: topics.title,
      objective: topics.objective,
      prerequisites: topics.prerequisites,
      completionRule: topics.completionRule,
      estimatedMinutes: topics.estimatedMinutes,
    })
    .from(topics)
    .where(and(forDraftCourse(scope, topics), isNull(topics.archivedAt)))
    .orderBy(asc(topics.position), asc(topics.createdAt));
  const rows = await db
    .select({
      /** Plays the `release_resources` id. */
      id: resources.id,
      releaseTopicId: resources.topicId,
      resourceId: resources.id,
      revisionId: resourceRevisions.id,
      type: resourceRevisions.type,
      credit: creditColumn,
      position: resources.position,
      title: resources.title,
      visibility: resources.visibility,
      releaseAt: resources.releaseAt,
    })
    .from(resources)
    .innerJoin(
      topics,
      and(
        eq(topics.id, resources.topicId),
        eq(topics.courseId, resources.courseId),
        isNull(topics.archivedAt),
      ),
    )
    .innerJoin(
      resourceRevisions,
      and(
        eq(resourceRevisions.id, resources.headRevisionId),
        eq(resourceRevisions.resourceId, resources.id),
        eq(resourceRevisions.courseId, resources.courseId),
        eq(resourceRevisions.type, resources.type),
      ),
    )
    .where(and(forDraftCourse(scope, resources), isNull(resources.archivedAt)))
    .orderBy(asc(resources.position), asc(resources.createdAt));
  // Ordered by topic as the snapshot lists them, then by resource position within each topic.
  const order = new Map(topicRows.map((t, i) => [t.id, i]));
  const resourceRows = rows
    .map((r) => ({ ...r, tab: tabOf[r.type], credit: creditOf(r.credit) }))
    .sort((a, b) => (order.get(a.releaseTopicId) ?? 0) - (order.get(b.releaseTopicId) ?? 0));
  return { topics: topicRows, resources: resourceRows };
}

export type DraftSnapshot = Awaited<ReturnType<typeof loadSnapshot>>;

/** Draft resources a preview may study at `now`: the same rule `studyableResource` applies. */
export async function studyableDraft(
  db: Db | Tx,
  scope: DraftPreviewScope,
  now: Date,
  draft?: DraftSnapshot,
): Promise<DraftSnapshot['resources']> {
  const { resources: rows } = draft ?? (await draftSnapshot(db, scope));
  return rows.filter((r) => scope.role !== 'student' || openToStudent(r, now));
}
