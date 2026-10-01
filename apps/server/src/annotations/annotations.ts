import { isDeepStrictEqual } from 'node:util';
import { type Anchor, anchorFits } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/annotations';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { studyableResource, studyVisible } from '../content/releases';
import type { Db } from '../db/client';
import { annotations, posts, releaseResources, threads, users } from '../db/schema';
import { forClass } from '../db/scoped';
import { invalid, notFound, type Outcome } from '../outcome';
import { loadPlacements, placementView } from './placements';
import { visiblePost, visibleTo } from './visibility';

/**
 * Annotations and discussions of one class (§8). Every function takes the resolved
 * `ClassScope`; every read filters through `visibility.ts`, and writes to an annotation
 * require its author, so a non-author learns only "not found".
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

/**
 * Each mark's placement on the revision the class studies now (ADR-0003), or null where the
 * caller can no longer study its resource. Marks are annotations or threads, never both.
 */
async function placementsOf(
  db: Db,
  scope: ClassScope,
  marks: Placed[],
  kind: 'annotation' | 'thread',
) {
  const pins = new Map<string, string | undefined>();
  for (const resourceId of new Set(marks.map((m) => m.resourceId))) {
    pins.set(resourceId, (await studyableResource(db, scope, resourceId))?.revisionId);
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

async function annotationViews(db: Db, scope: ClassScope, rows: AnnotationRow[]) {
  const placements = await placementsOf(db, scope, rows, 'annotation');
  return rows.map((row) => toAnnotation(row, placements.get(row.id) ?? null));
}

async function annotationView(db: Db, scope: ClassScope, row: AnnotationRow) {
  const [view] = await annotationViews(db, scope, [row]);
  if (!view) throw new Error('annotation view missing');
  return view;
}

/** The class's pinned revision of `resourceId`, if the caller may study it and `anchor` fits it. */
async function placeOn(db: Db, scope: ClassScope, resourceId: string, anchor: Anchor) {
  const resource = await studyableResource(db, scope, resourceId);
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

/** Threads matching `where` (already audience-filtered) with the posts the caller may read. */
async function loadThreads(db: Db, scope: ClassScope, where: ReturnType<typeof and>) {
  const rows = await db
    .select({ thread: threads, authorName: users.name })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.authorId))
    .where(where)
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
  const placements = await placementsOf(
    db,
    scope,
    rows.map((r) => r.thread),
    'thread',
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
      posts: postRows
        .filter((p) => p.post.threadId === thread.id)
        .map(({ post, authorName: name }) => {
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
 */
export async function listForResource(db: Db, scope: ClassScope, resourceId: string) {
  const own = await db
    .select()
    .from(annotations)
    .where(and(visibleTo(scope, annotations), eq(annotations.resourceId, resourceId)))
    .orderBy(asc(annotations.createdAt), asc(annotations.id));
  const studyable = await studyableResource(db, scope, resourceId);
  const discussion = studyable
    ? await loadThreads(
        db,
        scope,
        and(visibleTo(scope, threads), eq(threads.resourceId, resourceId)),
      )
    : [];
  return { annotations: await annotationViews(db, scope, own), threads: discussion };
}

export async function createAnnotation(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: CreateAnnotation,
  now: Date,
): Promise<Outcome<Annotation>> {
  const placed = await placeOn(db, scope, resourceId, input.anchor);
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
  return { ok: true, value: await annotationView(db, scope, row) };
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
  const { expectedRevision, ...changes } = input;
  const current = await ownAnnotation(db, scope, annotationId);
  if (!current) return notFound;
  const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
    (key) => changes[key] !== undefined && !isDeepStrictEqual(changes[key], current[key]),
  );
  if (changed.length === 0) return { ok: true, value: await annotationView(db, scope, current) };
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', current: await annotationView(db, scope, current) };
  }
  if (changes.anchor) {
    if (changes.anchor.kind !== current.anchor.kind) return misplaced;
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
  if (row) return { ok: true, value: await annotationView(db, scope, row) };
  const latest = await ownAnnotation(db, scope, annotationId);
  return latest
    ? { ok: false, reason: 'conflict', current: await annotationView(db, scope, latest) }
    : notFound;
}

export async function deleteAnnotation(db: Db, scope: ClassScope, annotationId: string) {
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
  return row;
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
  const [created] = await loadThreads(db, scope, and(forClass(scope, threads), eq(threads.id, id)));
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
  const placed = await placeOn(db, scope, resourceId, input.anchor);
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
  const note = await ownAnnotation(db, scope, annotationId);
  if (!note || !(await studyableResource(db, scope, note.resourceId))) return notFound;
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
export async function listNotifications(db: Db, scope: ClassScope): Promise<Notification[]> {
  if (!scope.releaseId) return [];
  const rows = await db
    .select({ thread: threads, authorName: users.name })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.authorId))
    .innerJoin(
      releaseResources,
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(releaseResources.resourceId, threads.resourceId),
        studyVisible(scope),
      ),
    )
    .where(and(visibleTo(scope, threads), ne(threads.authorId, scope.user.id)))
    .orderBy(desc(threads.createdAt), desc(threads.id))
    .limit(50);
  if (rows.length === 0) return [];
  const firsts = await db
    .select({ threadId: posts.threadId, body: posts.body, moderatedAt: posts.moderatedAt })
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
  return rows.map(({ thread, authorName }) => {
    const first = firsts.find((p) => p.threadId === thread.id);
    const body = first && !first.moderatedAt ? (first.body ?? '') : '';
    return {
      kind: 'thread',
      threadId: thread.id,
      resourceId: thread.resourceId,
      audience: thread.audience as Notification['audience'],
      author: { id: thread.authorId, name: authorName },
      excerpt: body.length > 140 ? `${body.slice(0, 139)}…` : body,
      createdAt: thread.createdAt.toISOString(),
    };
  });
}
