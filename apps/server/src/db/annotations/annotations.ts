import { isDeepStrictEqual } from 'node:util';
import { type Anchor, anchorFits } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/annotations';
import type * as placementContracts from '@parallax/contracts/routes/placements';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { excerpt } from '../../annotations/excerpt';
import { layoutOf, mapAnchor } from '../../annotations/mapping';
import type { ClassScope } from '../../auth/scope';
import { classArchived, invalid, notFound, type Outcome } from '../../outcome';
import type { Db } from '../client';
import { registerAffectedBy } from '../content/adoption';
import { studyableResource, studyableRows } from '../content/releases';
import {
  annotationPlacements,
  annotations,
  posts,
  releaseResources,
  resourceRevisions,
  threads,
  users,
} from '../schema';
import { forClass } from '../scoped';
import { visiblePost, visibleTo } from './visibility';

/**
 * Annotations and discussions of one class (§8). Every function takes the resolved
 * `ClassScope`; every read filters through `visibility.ts`, and writes to an annotation
 * require its author, so a non-author learns only "not found". Students reach a resource only
 * while `studyableRows` allows it (hidden or not yet released resources are "not found"), and
 * an archived class refuses every write but keeps its reads (§4).
 */

type Body<C extends { body?: z.ZodType }> = z.output<NonNullable<C['body']>>;
type Annotation = z.input<typeof contracts.annotationView>;
type Thread = z.input<typeof contracts.threadView>;
type Notification = z.input<typeof contracts.notificationView>;
type AnnotationRow = typeof annotations.$inferSelect;
type CreateAnnotation = Body<typeof contracts.createAnnotation>;
type SaveAnnotation = Body<typeof contracts.saveAnnotation>;
type CreateThread = Body<typeof contracts.createThread>;
type Share = Body<typeof contracts.shareAnnotation>;

const misplaced = invalid('This mark cannot be placed on this kind of material');

const toAnnotation = (row: AnnotationRow, placement: Annotation['placement']): Annotation => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceRevisionId: row.resourceRevisionId,
  kind: row.kind,
  audience: 'private',
  anchor: row.anchor,
  body: row.body,
  color: row.color,
  revision: row.revision,
  placement,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type Placed = { id: string; resourceId: string; resourceRevisionId: string; anchor: Anchor };

/** Resource id → the revision the caller studies it at, or undefined if they cannot. */
type Pins = Map<string, string | undefined>;

/**
 * Each mark's placement on the revision the class studies now (ADR-0003), or null where the
 * caller can no longer study its resource. Marks are annotations or threads, never both.
 * `known` carries pins the caller already resolved, so they are not looked up again.
 */
async function placementsOf(
  db: Db,
  scope: ClassScope,
  marks: Placed[],
  kind: 'annotation' | 'thread',
  now: Date,
  known: Pins = new Map(),
) {
  const pins: Pins = new Map(known);
  for (const resourceId of new Set(marks.map((m) => m.resourceId))) {
    if (pins.has(resourceId)) continue;
    pins.set(resourceId, (await studyableResource(db, scope, resourceId, now))?.revisionId);
  }
  const ids = marks.map((m) => m.id);
  const revisions = [...pins.values()].filter((r): r is string => r !== undefined);
  const rows = await loadPlacements(
    db,
    scope,
    kind === 'annotation' ? { annotationIds: ids } : { threadIds: ids },
    revisions,
  );
  return new Map(
    marks.map((m) => {
      const revisionId = pins.get(m.resourceId);
      return [m.id, placementView(m, revisionId, rows.get(`${m.id}:${revisionId}`))] as const;
    }),
  );
}

async function annotationViews(
  db: Db,
  scope: ClassScope,
  rows: AnnotationRow[],
  now: Date,
  pins?: Pins,
) {
  const placements = await placementsOf(db, scope, rows, 'annotation', now, pins);
  return rows.map((row) => toAnnotation(row, placements.get(row.id) ?? null));
}

async function annotationView(db: Db, scope: ClassScope, row: AnnotationRow, now: Date) {
  const [view] = await annotationViews(db, scope, [row], now);
  if (!view) throw new Error('annotation view missing');
  return view;
}

/** The class's pinned revision of `resourceId`, if the caller may study it and `anchor` fits it. */
async function placeOn(db: Db, scope: ClassScope, resourceId: string, anchor: Anchor, now: Date) {
  const resource = await studyableResource(db, scope, resourceId, now);
  if (!resource) return notFound;
  if (!anchorFits(resource.type, anchor)) return misplaced;
  return { ok: true, value: resource.revisionId } as const;
}

/** One of the caller's own annotations in this class. */
async function ownAnnotation(db: Db, scope: ClassScope, annotationId: string) {
  const [row] = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.id, annotationId),
        visibleTo(scope, annotations),
        eq(annotations.authorId, scope.user.id),
      ),
    );
  return row;
}

/**
 * Threads of the caller's class matching `where` (which applies the audience rule) with the
 * posts the caller may read and their placements at `now`.
 */
async function loadThreads(db: Db, scope: ClassScope, where: SQL, now: Date, pins?: Pins) {
  const rows = await db
    .select({ thread: threads, authorName: users.name })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.authorId))
    .where(and(forClass(scope, threads), where))
    .orderBy(asc(threads.createdAt), asc(threads.id));
  if (rows.length === 0) return [];
  const postRows = await db
    .select({ post: posts, authorName: users.name })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        inArray(
          posts.threadId,
          rows.map((r) => r.thread.id),
        ),
        visiblePost(scope, posts),
      ),
    )
    .orderBy(asc(posts.createdAt), asc(posts.id));
  const postsOf = new Map<string, typeof postRows>();
  for (const row of postRows) {
    const list = postsOf.get(row.post.threadId);
    if (list) list.push(row);
    else postsOf.set(row.post.threadId, [row]);
  }
  const placements = await placementsOf(
    db,
    scope,
    rows.map((r) => r.thread),
    'thread',
    now,
    pins,
  );
  return rows.map(
    ({ thread, authorName }): Thread => ({
      id: thread.id,
      resourceId: thread.resourceId,
      resourceRevisionId: thread.resourceRevisionId,
      anchor: thread.anchor,
      audience: thread.audience as Thread['audience'],
      status: thread.status,
      author: { id: thread.authorId, name: authorName },
      placement: placements.get(thread.id) ?? null,
      createdAt: thread.createdAt.toISOString(),
      posts: (postsOf.get(thread.id) ?? []).map(({ post, authorName: name }) => {
        const hidden = post.deletedAt !== null || post.moderatedAt !== null;
        return {
          id: post.id,
          parentId: post.parentId,
          author: { id: post.authorId, name },
          body: hidden ? null : post.body,
          edited: post.editedAt !== null,
          deleted: post.deletedAt !== null,
          moderated: post.moderatedAt !== null,
          createdAt: post.createdAt.toISOString(),
        };
      }),
    }),
  );
}

/**
 * The caller's own annotations on a resource, whether or not the class still studies it (§12:
 * removing a resource never deletes work), and its threads while the caller may study it.
 * Undefined (404) when the resource is neither open to the caller nor carries their marks.
 */
export async function listForResource(db: Db, scope: ClassScope, resourceId: string, now: Date) {
  const [own, studyable] = await Promise.all([
    db
      .select()
      .from(annotations)
      .where(and(visibleTo(scope, annotations), eq(annotations.resourceId, resourceId)))
      .orderBy(asc(annotations.createdAt), asc(annotations.id)),
    studyableResource(db, scope, resourceId, now),
  ]);
  if (!studyable && own.length === 0) return undefined;
  const pins: Pins = new Map([[resourceId, studyable?.revisionId]]);
  const discussion = studyable
    ? await loadThreads(
        db,
        scope,
        and(visibleTo(scope, threads), eq(threads.resourceId, resourceId)) as SQL,
        now,
        pins,
      )
    : [];
  return { annotations: await annotationViews(db, scope, own, now, pins), threads: discussion };
}

export async function createAnnotation(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: CreateAnnotation,
  now: Date,
): Promise<Outcome<Annotation>> {
  if (scope.archived) return classArchived;
  const placed = await placeOn(db, scope, resourceId, input.anchor, now);
  if (!placed.ok) return placed;
  const [row] = await db
    .insert(annotations)
    .values({
      classId: scope.classId,
      authorId: scope.user.id,
      resourceId,
      resourceRevisionId: placed.value,
      kind: input.kind,
      anchor: input.anchor,
      body: input.body ?? null,
      color: input.color ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('annotation insert returned no row');
  return { ok: true, value: await annotationView(db, scope, row, now) };
}

/**
 * Autosave. A request equal to the stored copy returns it unchanged, so blurring without edits
 * never creates a revision or a conflict; otherwise it applies only if `expectedRevision` is
 * current, and a stale one gets the server copy.
 */
export async function saveAnnotation(
  db: Db,
  scope: ClassScope,
  annotationId: string,
  input: SaveAnnotation,
  now: Date,
): Promise<Outcome<Annotation>> {
  if (scope.archived) return classArchived;
  const { expectedRevision, ...changes } = input;
  const current = await ownAnnotation(db, scope, annotationId);
  if (!current) return notFound;
  const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
    (key) => changes[key] !== undefined && !isDeepStrictEqual(changes[key], current[key]),
  );
  if (changed.length === 0)
    return { ok: true, value: await annotationView(db, scope, current, now) };
  if (current.revision !== expectedRevision) {
    return {
      ok: false,
      reason: 'conflict',
      current: await annotationView(db, scope, current, now),
    };
  }
  if (changes.anchor) {
    if (changes.anchor.kind !== current.anchor.kind) {
      return invalid('A mark cannot move to another kind of anchor');
    }
    const drawn = 'strokes' in changes.anchor && (changes.anchor.strokes?.length ?? 0) > 0;
    if (current.kind === 'sketch' && !drawn) return invalid('A sketch needs strokes');
  }
  const [row] = await db
    .update(annotations)
    .set({ ...changes, revision: sql`${annotations.revision} + 1`, updatedAt: now })
    .where(
      and(
        eq(annotations.id, annotationId),
        visibleTo(scope, annotations),
        eq(annotations.authorId, scope.user.id),
        eq(annotations.revision, expectedRevision),
      ),
    )
    .returning();
  if (row) return { ok: true, value: await annotationView(db, scope, row, now) };
  const latest = await ownAnnotation(db, scope, annotationId);
  return latest
    ? { ok: false, reason: 'conflict', current: await annotationView(db, scope, latest, now) }
    : notFound;
}

export async function deleteAnnotation(
  db: Db,
  scope: ClassScope,
  annotationId: string,
): Promise<Outcome<{ id: string }>> {
  if (scope.archived) return classArchived;
  const [row] = await db
    .delete(annotations)
    .where(
      and(
        eq(annotations.id, annotationId),
        visibleTo(scope, annotations),
        eq(annotations.authorId, scope.user.id),
      ),
    )
    .returning({ id: annotations.id });
  return row ? { ok: true, value: row } : notFound;
}

async function insertThread(
  db: Db,
  scope: ClassScope,
  values: {
    resourceId: string;
    resourceRevisionId: string;
    anchor: CreateThread['anchor'];
    audience: CreateThread['audience'];
    body: string;
    sourceAnnotationId?: string;
  },
  now: Date,
): Promise<Thread> {
  const { body, ...thread } = values;
  const isPreview = scope.membership.isPreview;
  const author = { classId: scope.classId, authorId: scope.user.id, isPreview, createdAt: now };
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(threads)
      .values({ ...author, ...thread, updatedAt: now })
      .returning({ id: threads.id });
    if (!row) throw new Error('thread insert returned no row');
    await tx.insert(posts).values({ ...author, threadId: row.id, body });
    return row.id;
  });
  const [created] = await loadThreads(db, scope, eq(threads.id, id), now);
  if (!created) throw new Error('created thread is not readable by its author');
  return created;
}

export async function createThread(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: CreateThread,
  now: Date,
): Promise<Outcome<Thread>> {
  if (scope.archived) return classArchived;
  const placed = await placeOn(db, scope, resourceId, input.anchor, now);
  if (!placed.ok) return placed;
  const resourceRevisionId = placed.value;
  return {
    ok: true,
    value: await insertThread(db, scope, { ...input, resourceId, resourceRevisionId }, now),
  };
}

/**
 * Copies only the annotation's anchor (its quote and context, or its drawing) and text into a
 * new thread; the annotation itself stays private.
 */
export async function shareAnnotation(
  db: Db,
  scope: ClassScope,
  annotationId: string,
  input: Share,
  now: Date,
): Promise<Outcome<Thread>> {
  if (scope.archived) return classArchived;
  const note = await ownAnnotation(db, scope, annotationId);
  if (!note || !(await studyableResource(db, scope, note.resourceId, now))) return notFound;
  const body = input.body ?? note.body?.trim();
  if (!body) return invalid('Write the question to share');
  const value = await insertThread(
    db,
    scope,
    {
      resourceId: note.resourceId,
      resourceRevisionId: note.resourceRevisionId,
      anchor: note.anchor,
      audience: input.audience,
      body,
      sourceAnnotationId: note.id,
    },
    now,
  );
  return { ok: true, value };
}

/**
 * Notification list (stub until delivery exists): the newest threads by other people that the
 * caller may read, on resources the caller may study now. Same rules as the margin (§13).
 */
export async function listNotifications(
  db: Db,
  scope: ClassScope,
  now: Date,
): Promise<Notification[]> {
  if (!scope.releaseId) return [];
  const rows = await db
    .select({ thread: threads, authorName: users.name })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.authorId))
    .innerJoin(
      releaseResources,
      and(eq(releaseResources.resourceId, threads.resourceId), studyableRows(scope, now)),
    )
    .where(and(visibleTo(scope, threads), ne(threads.authorId, scope.user.id)))
    .orderBy(desc(threads.createdAt), desc(threads.id))
    .limit(50);
  if (rows.length === 0) return [];
  const firsts = await db
    .select({
      threadId: posts.threadId,
      body: posts.body,
      moderatedAt: posts.moderatedAt,
      deletedAt: posts.deletedAt,
    })
    .from(posts)
    .where(
      and(
        forClass(scope, posts),
        isNull(posts.parentId),
        inArray(
          posts.threadId,
          rows.map((r) => r.thread.id),
        ),
      ),
    )
    .orderBy(asc(posts.createdAt));
  const firstOf = new Map<string, (typeof firsts)[number]>();
  for (const post of firsts) if (!firstOf.has(post.threadId)) firstOf.set(post.threadId, post);
  return rows.map(({ thread, authorName }) => {
    const first = firstOf.get(thread.id);
    const body = first && !first.moderatedAt && !first.deletedAt ? (first.body ?? '') : '';
    return {
      kind: 'thread',
      threadId: thread.id,
      resourceId: thread.resourceId,
      audience: thread.audience as Notification['audience'],
      author: { id: thread.authorId, name: authorName },
      excerpt: excerpt(body),
      createdAt: thread.createdAt.toISOString(),
    };
  });
}

/**
 * Placements of a class's annotations and threads on the revisions its release pins
 * (ADR-0003). The mapping job writes `mapped` or `needs_reattachment` once per mark and
 * revision; manual placements replace either and are never overwritten by the job.
 */

type Placement = z.input<typeof placementContracts.placeMark.response>;
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
  if (scope.archived) return classArchived;
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
  const pin = await studyableResource(db, scope, mark.resourceId, now);
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

type MappingList = z.input<typeof placementContracts.listPlacements.response>;

/**
 * The instructor's "map annotations" list: threads the caller can read whose resource the
 * release now pins at another revision. Private notes are never read here (§8, A05).
 */
export async function listMapping(db: Db, scope: ClassScope): Promise<MappingList> {
  const pins = await pinsOf(db, scope);
  if (pins.size === 0) return { releaseId: scope.releaseId, threads: [] };
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
  const placed = await loadPlacements(
    db,
    scope,
    { threadIds: asked.map((a) => a.thread.id) },
    pinned,
  );
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
  return { releaseId: scope.releaseId, threads: items };
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
