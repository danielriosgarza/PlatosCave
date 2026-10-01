import type { adoptionDiff } from '@parallax/contracts/routes/releases';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import type { Db } from '../db/client';
import {
  auditEvents,
  classes,
  classReleaseHistory,
  courseReleases,
  releaseResources,
  releaseTopics,
  users,
} from '../db/schema';
import { forClass } from '../db/scoped';
import type { Tx } from './releases';

export type AdoptionDiff = z.infer<typeof adoptionDiff>;
type Executor = Db | Tx;
type Counts = { annotations: number; assignments: number };
type ReleaseRef = { id: string; version: number };

/**
 * Counts, per resource revision, the class's records that reference it. Annotations (P2-04)
 * and assignments (P3-15) register one each; until then adoption reports zero.
 */
export type AffectedCounter = (
  ex: Executor,
  scope: ClassScope,
  revisionIds: string[],
) => Promise<Map<string, number>>;

const counters = new Map<keyof Counts, AffectedCounter>();

/** Registers the counter for one kind of class record; returns a function that removes it. */
export function registerAffectedBy(kind: keyof Counts, counter: AffectedCounter): () => void {
  counters.set(kind, counter);
  return () => {
    if (counters.get(kind) === counter) counters.delete(kind);
  };
}

/** A release of the class's own course, or undefined. */
async function findRelease(ex: Executor, scope: ClassScope, releaseId: string) {
  const [row] = await ex
    .select({ id: courseReleases.id, version: courseReleases.version })
    .from(courseReleases)
    .where(and(eq(courseReleases.id, releaseId), eq(courseReleases.courseId, scope.courseId)));
  return row;
}

async function snapshot(ex: Executor, releaseId: string) {
  const rows = await ex
    .select({
      resourceId: releaseResources.resourceId,
      revisionId: releaseResources.resourceRevisionId,
      title: releaseResources.title,
      tab: releaseResources.tab,
      position: releaseResources.position,
      visibility: releaseResources.visibility,
      releaseAt: releaseResources.releaseAt,
      topicId: releaseTopics.topicId,
      topicTitle: releaseTopics.title,
    })
    .from(releaseResources)
    .innerJoin(releaseTopics, eq(releaseTopics.id, releaseResources.releaseTopicId))
    .where(eq(releaseResources.releaseId, releaseId))
    .orderBy(asc(releaseTopics.position), asc(releaseResources.position));
  return new Map(rows.map((r) => [r.resourceId, r]));
}

/**
 * Adoption diff (ADR-0003): the two releases' resources joined by draft resource id, plus how
 * many of the class's annotations and assignments reference a removed or replaced revision.
 */
export async function diffReleases(
  ex: Executor,
  scope: ClassScope,
  from: ReleaseRef | null,
  to: ReleaseRef,
): Promise<AdoptionDiff> {
  const before = from ? await snapshot(ex, from.id) : new Map();
  const after = await snapshot(ex, to.id);
  const entry = (r: { resourceId: string; title: string; tab: string; topicTitle: string }) => ({
    resourceId: r.resourceId,
    title: r.title,
    tab: r.tab as AdoptionDiff['added'][number]['tab'],
    topicTitle: r.topicTitle,
  });
  const added = [...after.values()]
    .filter((r) => !before.has(r.resourceId))
    .map((r) => ({ ...entry(r), revisionId: r.revisionId }));
  const removed = [...before.values()]
    .filter((r) => !after.has(r.resourceId))
    .map((r) => ({ ...entry(r), revisionId: r.revisionId }));
  const changed = [...after.values()].flatMap((r) => {
    const old = before.get(r.resourceId);
    if (!old) return [];
    const fields = [
      old.revisionId !== r.revisionId && 'revision',
      old.title !== r.title && 'title',
      old.tab !== r.tab && 'tab',
      old.topicId !== r.topicId && 'topic',
      old.position !== r.position && 'position',
      old.visibility !== r.visibility && 'visibility',
      old.releaseAt?.getTime() !== r.releaseAt?.getTime() && 'releaseAt',
    ].filter((f): f is string => f !== false);
    if (fields.length === 0) return [];
    return [{ ...entry(r), fromRevisionId: old.revisionId, toRevisionId: r.revisionId, fields }];
  });

  // Work recorded against a revision the class stops using: removed, or replaced by another.
  const gone = [
    ...removed.map((r) => r.revisionId),
    ...changed.filter((c) => c.fields.includes('revision')).map((c) => c.fromRevisionId),
  ];
  const tallies: Record<keyof Counts, Map<string, number>> = {
    annotations: new Map(),
    assignments: new Map(),
  };
  if (gone.length > 0) {
    for (const [kind, counter] of counters) tallies[kind] = await counter(ex, scope, gone);
  }
  const affected = (revisionId: string, counts: boolean): Counts => ({
    annotations: counts ? (tallies.annotations.get(revisionId) ?? 0) : 0,
    assignments: counts ? (tallies.assignments.get(revisionId) ?? 0) : 0,
  });
  const removedOut = removed.map((r) => ({ ...r, affected: affected(r.revisionId, true) }));
  const changedOut = changed.map((c) => ({
    ...c,
    affected: affected(c.fromRevisionId, c.fields.includes('revision')),
  }));
  const sum = (kind: keyof Counts) =>
    [...removedOut, ...changedOut].reduce((n, e) => n + e.affected[kind], 0);
  return {
    from,
    to,
    added,
    removed: removedOut,
    changed: changedOut,
    totals: {
      added: added.length,
      removed: removedOut.length,
      changed: changedOut.length,
      annotations: sum('annotations'),
      assignments: sum('assignments'),
    },
  };
}

/** The diff the class would see by adopting `releaseId`; undefined if it is not of its course. */
export async function previewAdoption(db: Db, scope: ClassScope, releaseId: string) {
  const to = await findRelease(db, scope, releaseId);
  if (!to) return undefined;
  const from = scope.releaseId ? ((await findRelease(db, scope, scope.releaseId)) ?? null) : null;
  return diffReleases(db, scope, from, to);
}

export type AdoptResult =
  | { ok: true; releaseId: string; diff: AdoptionDiff }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'class_archived' }
  | { ok: false; reason: 'release_conflict'; currentReleaseId: string | null };

/**
 * Moves the class to another release of its course (§12). The class row is locked and must
 * still be on `expectedReleaseId`, so two instructors cannot adopt over each other silently.
 * Adopting the current release again changes nothing and records nothing.
 */
export function adoptRelease(
  db: Db,
  scope: ClassScope,
  input: { releaseId: string; expectedReleaseId: string | null },
): Promise<AdoptResult> {
  return db.transaction(async (tx) => {
    const [cls] = await tx
      .select({ releaseId: classes.releaseId, archivedAt: classes.archivedAt })
      .from(classes)
      .where(eq(classes.id, scope.classId))
      .for('update');
    if (!cls) return { ok: false, reason: 'not_found' };
    if (cls.archivedAt) return { ok: false, reason: 'class_archived' };
    const to = await findRelease(tx, scope, input.releaseId);
    if (!to) return { ok: false, reason: 'not_found' };
    if (cls.releaseId !== input.expectedReleaseId) {
      return { ok: false, reason: 'release_conflict', currentReleaseId: cls.releaseId };
    }
    const from = cls.releaseId ? ((await findRelease(tx, scope, cls.releaseId)) ?? null) : null;
    const diff = await diffReleases(tx, scope, from, to);
    if (from?.id === to.id) return { ok: true, releaseId: to.id, diff };

    await tx.update(classes).set({ releaseId: to.id }).where(eq(classes.id, scope.classId));
    await tx.insert(classReleaseHistory).values({
      classId: scope.classId,
      fromReleaseId: from?.id ?? null,
      toReleaseId: to.id,
      actorId: scope.user.id,
      diff,
    });
    await tx.insert(auditEvents).values({
      actorId: scope.user.id,
      action: 'release.adopt',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'course_release',
      targetId: to.id,
      before: from && { releaseId: from.id, version: from.version },
      after: { releaseId: to.id, version: to.version, ...diff.totals },
    });
    return { ok: true, releaseId: to.id, diff };
  });
}

/** Releases the class may adopt (newest first) and its adoption history (oldest first). */
export async function listClassReleases(db: Db, scope: ClassScope) {
  const releases = await db
    .select({
      id: courseReleases.id,
      version: courseReleases.version,
      createdAt: courseReleases.createdAt,
    })
    .from(courseReleases)
    .where(eq(courseReleases.courseId, scope.courseId))
    .orderBy(desc(courseReleases.version));
  const history = await db
    .select({
      id: classReleaseHistory.id,
      diff: classReleaseHistory.diff,
      createdAt: classReleaseHistory.createdAt,
      actorId: users.id,
      actorName: users.name,
    })
    .from(classReleaseHistory)
    .leftJoin(users, eq(users.id, classReleaseHistory.actorId))
    .where(forClass(scope, classReleaseHistory))
    .orderBy(asc(classReleaseHistory.createdAt), asc(classReleaseHistory.id));
  return {
    currentReleaseId: scope.releaseId,
    releases,
    history: history.map((h) => {
      const diff = h.diff as AdoptionDiff;
      return {
        id: h.id,
        from: diff.from,
        to: diff.to,
        actor: h.actorId && h.actorName !== null ? { id: h.actorId, name: h.actorName } : null,
        diff,
        createdAt: h.createdAt,
      };
    }),
  };
}
