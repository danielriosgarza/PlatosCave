import { isDeepStrictEqual } from 'node:util';
import { type Anchor, anchorFits } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/annotations';
import { and, asc, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { studyableResource, studyableRows } from '../content/releases';
import type { Db } from '../db/client';
import { annotations, posts, releaseResources, threads, users } from '../db/schema';
import { forClass } from '../db/scoped';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
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

const toAnnotation = (row: AnnotationRow): Annotation => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceRevisionId: row.resourceRevisionId,
  kind: row.kind,
  audience: 'private',
  anchor: row.anchor,
  body: row.body,
  color: row.color,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

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
 * posts the caller may read.
 */
async function loadThreads(db: Db, scope: ClassScope, where: SQL) {
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
  return rows.map(
    ({ thread, authorName }): Thread => ({
      id: thread.id,
      resourceId: thread.resourceId,
      resourceRevisionId: thread.resourceRevisionId,
      anchor: thread.anchor,
      audience: thread.audience as Thread['audience'],
      status: thread.status,
      author: { id: thread.authorId, name: authorName },
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
  const discussion = studyable
    ? await loadThreads(
        db,
        scope,
        and(visibleTo(scope, threads), eq(threads.resourceId, resourceId)) as SQL,
      )
    : [];
  return { annotations: own.map(toAnnotation), threads: discussion };
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
  return { ok: true, value: toAnnotation(row) };
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
  if (changed.length === 0) return { ok: true, value: toAnnotation(current) };
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', current: toAnnotation(current) };
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
  if (row) return { ok: true, value: toAnnotation(row) };
  const latest = await ownAnnotation(db, scope, annotationId);
  return latest ? { ok: false, reason: 'conflict', current: toAnnotation(latest) } : notFound;
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
  const [created] = await loadThreads(db, scope, eq(threads.id, id));
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

/** At most 140 characters, cut on whole code points so no surrogate pair is split. */
export function excerpt(body: string): string {
  const chars = Array.from(body);
  return chars.length > 140 ? `${chars.slice(0, 139).join('')}…` : body;
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
      excerpt: excerpt(body),
      createdAt: thread.createdAt.toISOString(),
    };
  });
}
