import type * as contracts from '@parallax/contracts/routes/annotations';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import type { Outcome } from '../content/drafts';
import type { Db } from '../db/client';
import { annotations, posts, releaseResources, threads, users } from '../db/schema';
import { forClass } from '../db/scoped';
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

const notFound = { ok: false, reason: 'not_found' } as const;

const toAnnotation = (row: AnnotationRow): Annotation => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceRevisionId: row.resourceRevisionId,
  kind: row.kind,
  audience: 'private',
  anchor: row.anchor,
  body: row.body,
  color: row.color,
  strokes: row.strokes,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * The revision of `resourceId` pinned by the class's adopted release, if the caller may study
 * it: students never reach hidden resources (A26), and drafts are never reachable here.
 */
async function releasedRevision(db: Db, scope: ClassScope, resourceId: string) {
  if (!scope.releaseId) return undefined;
  const [row] = await db
    .select({ revisionId: releaseResources.resourceRevisionId })
    .from(releaseResources)
    .where(
      and(
        eq(releaseResources.releaseId, scope.releaseId),
        eq(releaseResources.resourceId, resourceId),
        scope.role === 'student' ? ne(releaseResources.visibility, 'hidden') : sql`true`,
      ),
    );
  return row?.revisionId;
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

export async function listForResource(db: Db, scope: ClassScope, resourceId: string) {
  if (!(await releasedRevision(db, scope, resourceId))) return undefined;
  const own = await db
    .select()
    .from(annotations)
    .where(and(visibleTo(scope, annotations), eq(annotations.resourceId, resourceId)))
    .orderBy(asc(annotations.createdAt), asc(annotations.id));
  const discussion = await loadThreads(
    db,
    scope,
    and(visibleTo(scope, threads), eq(threads.resourceId, resourceId)),
  );
  return { annotations: own.map(toAnnotation), threads: discussion };
}

export async function createAnnotation(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: CreateAnnotation,
  now: Date,
): Promise<Outcome<Annotation>> {
  const revisionId = await releasedRevision(db, scope, resourceId);
  if (!revisionId) return notFound;
  const [row] = await db
    .insert(annotations)
    .values({
      classId: scope.classId,
      authorId: scope.user.id,
      resourceId,
      resourceRevisionId: revisionId,
      kind: input.kind,
      anchor: input.anchor,
      body: input.body ?? null,
      color: input.color ?? null,
      strokes: input.strokes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('annotation insert returned no row');
  return { ok: true, value: toAnnotation(row) };
}

/** Autosave: applies only if `expectedRevision` is current, otherwise returns the server copy. */
export async function saveAnnotation(
  db: Db,
  scope: ClassScope,
  annotationId: string,
  input: SaveAnnotation,
  now: Date,
): Promise<Outcome<Annotation>> {
  const { expectedRevision, ...changes } = input;
  if (changes.strokes != null) {
    const current = await ownAnnotation(db, scope, annotationId);
    if (!current) return notFound;
    if (current.kind !== 'sketch') {
      return { ok: false, reason: 'invalid', message: 'only sketches carry strokes' };
    }
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
  const current = await ownAnnotation(db, scope, annotationId);
  if (!current) return notFound;
  return { ok: false, reason: 'conflict', current: toAnnotation(current) };
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
  const resourceRevisionId = await releasedRevision(db, scope, resourceId);
  if (!resourceRevisionId) return notFound;
  return {
    ok: true,
    value: await insertThread(db, scope, { ...input, resourceId, resourceRevisionId }, now),
  };
}

/** Copies only the annotation's anchor (with its quote and context) and text into a thread. */
export async function shareAnnotation(
  db: Db,
  scope: ClassScope,
  annotationId: string,
  input: Share,
  now: Date,
): Promise<Outcome<Thread>> {
  const note = await ownAnnotation(db, scope, annotationId);
  if (!note || !(await releasedRevision(db, scope, note.resourceId))) return notFound;
  const body = input.body ?? note.body?.trim();
  if (!body) return { ok: false, reason: 'invalid', message: 'Write the question to share' };
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
 * caller may read. It applies the same audience rule as every other read (§13).
 */
export async function listNotifications(db: Db, scope: ClassScope): Promise<Notification[]> {
  const rows = await db
    .select({ thread: threads, authorName: users.name })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.authorId))
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
