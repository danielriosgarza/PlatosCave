import { type Anchor, anchorFits } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/placements';
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { registerAffectedBy } from '../content/adoption';
import { studyableResource } from '../content/releases';
import type { Db } from '../db/client';
import {
  annotationPlacements,
  annotations,
  releaseResources,
  resourceRevisions,
  threads,
  users,
} from '../db/schema';
import { forClass } from '../db/scoped';
import { invalid, notFound, type Outcome } from '../outcome';
import { layoutOf, mapAnchor } from './mapping';
import { visibleTo } from './visibility';

/**
 * Placements of a class's annotations and threads on the revisions its release pins
 * (ADR-0003). The mapping job writes `mapped` or `needs_reattachment` once per mark and
 * revision; manual placements replace either and are never overwritten by the job.
 */

type Placement = z.input<typeof contracts.placeMark.response>;
type PlacementRow = typeof annotationPlacements.$inferSelect;
type Mark = { id: string; resourceId: string; resourceRevisionId: string; anchor: Anchor };
export type Target = { annotationId: string } | { threadId: string };

/** Every resource of the class's release with its pinned revision and derived outputs. */
async function pinsOf(db: Db, scope: ClassScope) {
  if (!scope.releaseId) return new Map<string, never>();
  const rows = await db
    .select({
      resourceId: releaseResources.resourceId,
      title: releaseResources.title,
      revisionId: releaseResources.resourceRevisionId,
      type: resourceRevisions.type,
      derived: resourceRevisions.derived,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(resourceRevisions.courseId, scope.courseId),
      ),
    );
  return new Map(rows.map((r) => [r.resourceId, r]));
}

/**
 * The mark's placement on `revisionId` as the client shows it: the original anchor when the
 * class still uses the revision it was made on, else the stored placement, else pending.
 */
export function placementView(
  mark: Pick<Mark, 'resourceRevisionId' | 'anchor'>,
  revisionId: string | undefined,
  row: PlacementRow | undefined,
): Placement | null {
  if (!revisionId) return null;
  if (revisionId === mark.resourceRevisionId) {
    return {
      resourceRevisionId: revisionId,
      status: 'original',
      anchor: mark.anchor,
      confidence: 1,
    };
  }
  if (!row)
    return { resourceRevisionId: revisionId, status: 'pending', anchor: null, confidence: null };
  return {
    resourceRevisionId: revisionId,
    status: row.status,
    anchor: row.anchor,
    confidence: row.confidence,
  };
}

/** Stored placements of the given marks on the given revisions, keyed `<markId>:<revisionId>`. */
export async function loadPlacements(
  db: Db,
  scope: ClassScope,
  marks: { annotationIds?: string[]; threadIds?: string[] },
  revisionIds: string[],
): Promise<Map<string, PlacementRow>> {
  const [aIds, tIds] = [marks.annotationIds ?? [], marks.threadIds ?? []];
  if (revisionIds.length === 0 || aIds.length + tIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(annotationPlacements)
    .where(
      and(
        forClass(scope, annotationPlacements),
        inArray(annotationPlacements.resourceRevisionId, revisionIds),
        or(
          aIds.length ? inArray(annotationPlacements.annotationId, aIds) : sql`false`,
          tIds.length ? inArray(annotationPlacements.threadId, tIds) : sql`false`,
        ),
      ),
    );
  return new Map(
    rows.map((r) => [`${r.annotationId ?? r.threadId}:${r.resourceRevisionId}`, r] as const),
  );
}

export interface MapResult {
  mapped: number;
  needsReattachment: number;
  /** Marks on revisions whose derived outputs are not ready; a later run maps them. */
  pending: number;
}

/**
 * The `annotations.map` job body: places every annotation and thread of the class whose
 * resource the release pins at a revision other than the one the mark was made on, and that
 * has no placement there yet. Each mark maps from its newest anchored placement (a manual one
 * included), else from its original anchor. Idempotent; concurrent runs insert each once.
 */
export async function mapClass(db: Db, scope: ClassScope): Promise<MapResult> {
  const result: MapResult = { mapped: 0, needsReattachment: 0, pending: 0 };
  const pins = await pinsOf(db, scope);
  if (pins.size === 0) return result;
  const resourceIds = [...pins.keys()];
  const fields = <T extends typeof annotations | typeof threads>(t: T) => ({
    id: t.id,
    resourceId: t.resourceId,
    resourceRevisionId: t.resourceRevisionId,
    anchor: t.anchor,
  });
  const where = <T extends typeof annotations | typeof threads>(t: T) =>
    and(forClass(scope, t), inArray(t.resourceId, resourceIds));
  const moved = (rows: Mark[]) =>
    rows.filter((m) => pins.get(m.resourceId)?.revisionId !== m.resourceRevisionId);
  const notes = moved(
    await db.select(fields(annotations)).from(annotations).where(where(annotations)),
  );
  const asked = moved(await db.select(fields(threads)).from(threads).where(where(threads)));
  if (notes.length + asked.length === 0) return result;

  const marks = { annotationIds: notes.map((m) => m.id), threadIds: asked.map((m) => m.id) };
  const pinned = [...pins.values()].map((p) => p.revisionId);
  const placed = await loadPlacements(db, scope, marks, pinned);
  // Anchored placement on the newest revision per mark: the best starting point after a
  // manual reattachment on an intermediate release.
  const history = await db
    .select({ row: annotationPlacements })
    .from(annotationPlacements)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, annotationPlacements.resourceRevisionId))
    .where(
      and(
        forClass(scope, annotationPlacements),
        isNotNull(annotationPlacements.anchor),
        or(
          marks.annotationIds.length
            ? inArray(annotationPlacements.annotationId, marks.annotationIds)
            : sql`false`,
          marks.threadIds.length
            ? inArray(annotationPlacements.threadId, marks.threadIds)
            : sql`false`,
        ),
      ),
    )
    .orderBy(desc(resourceRevisions.createdAt), desc(annotationPlacements.updatedAt));
  const latest = new Map<string, PlacementRow>();
  for (const { row } of history) {
    const key = row.annotationId ?? row.threadId ?? '';
    if (!latest.has(key)) latest.set(key, row);
  }

  const sources = new Set<string>();
  for (const m of [...notes, ...asked]) {
    sources.add(latest.get(m.id)?.resourceRevisionId ?? m.resourceRevisionId);
  }
  const revisionRows = await db
    .select({
      id: resourceRevisions.id,
      type: resourceRevisions.type,
      derived: resourceRevisions.derived,
    })
    .from(resourceRevisions)
    .where(
      and(
        inArray(resourceRevisions.id, [...sources]),
        eq(resourceRevisions.courseId, scope.courseId),
      ),
    );
  const layouts = new Map(revisionRows.map((r) => [r.id, layoutOf(r.type, r.derived)]));

  const place = async (mark: Mark, target: 'annotationId' | 'threadId') => {
    const pin = pins.get(mark.resourceId);
    if (!pin || placed.has(`${mark.id}:${pin.revisionId}`)) return;
    const to = layoutOf(pin.type, pin.derived);
    if (!to) {
      result.pending += 1;
      return;
    }
    const from = latest.get(mark.id);
    const source = from?.anchor
      ? { revisionId: from.resourceRevisionId, anchor: from.anchor }
      : { revisionId: mark.resourceRevisionId, anchor: mark.anchor };
    const mapping =
      source.revisionId === pin.revisionId
        ? ({ status: 'mapped', anchor: source.anchor, confidence: 1 } as const)
        : mapAnchor(source.anchor, layouts.get(source.revisionId), to);
    await db
      .insert(annotationPlacements)
      .values({
        classId: scope.classId,
        [target]: mark.id,
        resourceRevisionId: pin.revisionId,
        status: mapping.status,
        anchor: mapping.status === 'mapped' ? mapping.anchor : null,
        confidence: mapping.status === 'mapped' ? mapping.confidence : null,
      })
      .onConflictDoNothing();
    if (mapping.status === 'mapped') result.mapped += 1;
    else result.needsReattachment += 1;
  };
  for (const mark of notes) await place(mark, 'annotationId');
  for (const mark of asked) await place(mark, 'threadId');
  return result;
}

const misplaced = invalid('This mark cannot be placed on this kind of material');

/**
 * Manual placement (ADR-0003) on the revision the class studies now. Annotations: their
 * author only, as they are private. Threads: their author or an instructor who can read them.
 */
export async function placeMark(
  db: Db,
  scope: ClassScope,
  target: Target,
  anchor: Anchor,
  now: Date,
): Promise<Outcome<Placement>> {
  let mark: (Mark & { kind?: string }) | undefined;
  if ('annotationId' in target) {
    [mark] = await db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.id, target.annotationId),
          visibleTo(scope, annotations),
          eq(annotations.authorId, scope.user.id),
        ),
      );
  } else {
    const [row] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, target.threadId), visibleTo(scope, threads)));
    if (row && (scope.role === 'instructor' || row.authorId === scope.user.id)) mark = row;
  }
  if (!mark) return notFound;
  const pin = await studyableResource(db, scope, mark.resourceId);
  if (!pin) return notFound;
  if (pin.revisionId === mark.resourceRevisionId) {
    return invalid('This mark is already on the revision the class uses; edit it instead');
  }
  if (anchor.kind !== mark.anchor.kind || !anchorFits(pin.type, anchor)) return misplaced;
  if (mark.kind === 'sketch' && !('strokes' in anchor && (anchor.strokes?.length ?? 0) > 0)) {
    return invalid('A sketch needs strokes');
  }
  const column = 'annotationId' in target ? 'annotationId' : 'threadId';
  const values = {
    anchor,
    status: 'manual' as const,
    confidence: null,
    placedBy: scope.user.id,
    updatedAt: now,
  };
  const [row] = await db
    .insert(annotationPlacements)
    .values({
      classId: scope.classId,
      [column]: mark.id,
      resourceRevisionId: pin.revisionId,
      createdAt: now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [annotationPlacements[column], annotationPlacements.resourceRevisionId],
      set: values,
    })
    .returning();
  const view = placementView(mark, pin.revisionId, row);
  if (!view) throw new Error('placement without a revision');
  return { ok: true, value: view };
}

type MappingList = z.input<typeof contracts.listPlacements.response>;

/** The instructor's "map annotations" list: readable threads on changed revisions, plus counts. */
export async function listMapping(db: Db, scope: ClassScope): Promise<MappingList> {
  const pins = await pinsOf(db, scope);
  const empty = { needsReattachment: 0, pending: 0 };
  if (pins.size === 0)
    return { releaseId: scope.releaseId, threads: [], privateAnnotations: empty };
  const resourceIds = [...pins.keys()];
  const pinned = [...pins.values()].map((p) => p.revisionId);
  const asked = (
    await db
      .select({ thread: threads, authorName: users.name })
      .from(threads)
      .innerJoin(users, eq(users.id, threads.authorId))
      .where(and(visibleTo(scope, threads), inArray(threads.resourceId, resourceIds)))
      .orderBy(asc(threads.createdAt), asc(threads.id))
  ).filter(({ thread }) => pins.get(thread.resourceId)?.revisionId !== thread.resourceRevisionId);
  const notes = (
    await db
      .select({
        id: annotations.id,
        resourceId: annotations.resourceId,
        revisionId: annotations.resourceRevisionId,
      })
      .from(annotations)
      .where(and(forClass(scope, annotations), inArray(annotations.resourceId, resourceIds)))
  ).filter((n) => pins.get(n.resourceId)?.revisionId !== n.revisionId);
  const placed = await loadPlacements(
    db,
    scope,
    { threadIds: asked.map((a) => a.thread.id), annotationIds: notes.map((n) => n.id) },
    pinned,
  );
  const privateAnnotations = { ...empty };
  for (const note of notes) {
    const status = placed.get(`${note.id}:${pins.get(note.resourceId)?.revisionId}`)?.status;
    if (status === 'needs_reattachment') privateAnnotations.needsReattachment += 1;
    if (!status) privateAnnotations.pending += 1;
  }
  const order = { needs_reattachment: 0, pending: 1, manual: 2, mapped: 3, original: 4 };
  const items = asked.flatMap(({ thread, authorName }) => {
    const pin = pins.get(thread.resourceId);
    const placement = placementView(
      thread,
      pin?.revisionId,
      placed.get(`${thread.id}:${pin?.revisionId}`),
    );
    if (!pin || !placement) return [];
    return [
      {
        threadId: thread.id,
        resourceId: thread.resourceId,
        resourceTitle: pin.title,
        audience: thread.audience as 'instructor' | 'class',
        author: { id: thread.authorId, name: authorName },
        originalRevisionId: thread.resourceRevisionId,
        anchor: thread.anchor,
        placement,
      },
    ];
  });
  items.sort((a, b) => order[a.placement.status] - order[b.placement.status]);
  return { releaseId: scope.releaseId, threads: items, privateAnnotations };
}

/**
 * Adoption diff (ADR-0003): how many of the class's annotations and threads sit on each
 * revision the class stops using, by their original revision or a placement on it.
 */
registerAffectedBy('annotations', async (ex, scope, revisionIds) => {
  const counts = new Map<string, number>();
  const tally = (rows: { revisionId: string; n: number }[]) => {
    for (const r of rows) counts.set(r.revisionId, (counts.get(r.revisionId) ?? 0) + Number(r.n));
  };
  for (const t of [annotations, threads] as const) {
    const markColumn =
      t === annotations ? annotationPlacements.annotationId : annotationPlacements.threadId;
    tally(
      await ex
        .select({ revisionId: t.resourceRevisionId, n: sql<number>`count(*)` })
        .from(t)
        .where(and(forClass(scope, t), inArray(t.resourceRevisionId, revisionIds)))
        .groupBy(t.resourceRevisionId),
    );
    // Marks made on an older revision and placed on one the class now leaves.
    tally(
      await ex
        .select({ revisionId: annotationPlacements.resourceRevisionId, n: sql<number>`count(*)` })
        .from(annotationPlacements)
        .innerJoin(t, eq(t.id, markColumn))
        .where(
          and(
            forClass(scope, annotationPlacements),
            inArray(annotationPlacements.resourceRevisionId, revisionIds),
            sql`${t.resourceRevisionId} <> ${annotationPlacements.resourceRevisionId}`,
          ),
        )
        .groupBy(annotationPlacements.resourceRevisionId),
    );
  }
  return counts;
});
