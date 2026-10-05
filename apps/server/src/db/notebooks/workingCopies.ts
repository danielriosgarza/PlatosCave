import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ClassScope } from '../../auth/scope';
import type { StoredObject } from '../../storage/storage';
import type { Db, Executor } from '../client';
import { studyableRows } from '../content/releases';
import {
  notebookSessions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  releaseResources,
  resourceRevisions,
  storageObjects,
} from '../schema';
import { forClass } from '../scoped';

/**
 * Notebook working copies (spec §10.5, docs/design/connector.md §11). A person reads and writes
 * only their own working copies through a resolved class scope; anyone else's, the class
 * instructor's included, reads as missing. Revisions are append-only: a save names the revision
 * it edited and is refused when another was saved meanwhile (ADR-0003).
 */

export type WorkingCopyRow = typeof notebookWorkingCopies.$inferSelect;
export type WorkingCopyRevisionRow = typeof notebookWorkingCopyRevisions.$inferSelect;

const mine = (scope: ClassScope) =>
  and(forClass(scope, notebookWorkingCopies), eq(notebookWorkingCopies.userId, scope.user.id));

/** The course notebook a first Connect copies: its stored `.ipynb`, title and resource. */
export interface SourceNotebook {
  revisionId: string;
  resourceId: string;
  title: string;
  /** The uploaded `.ipynb`, when the revision names one among its own objects. */
  sourceKey: string | null;
}

/**
 * The notebook revision of the class's release the caller may study now, with its uploaded
 * source; null when it is not one.
 */
export async function studyableNotebook(
  db: Executor,
  scope: ClassScope,
  revisionId: string,
  now: Date,
): Promise<SourceNotebook | null> {
  const [row] = await db
    .select({
      resourceId: releaseResources.resourceId,
      title: releaseResources.title,
      content: resourceRevisions.content,
      objectKeys: resourceRevisions.objectKeys,
    })
    .from(releaseResources)
    .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
    .where(
      and(
        studyableRows(scope, now),
        eq(releaseResources.resourceRevisionId, revisionId),
        eq(resourceRevisions.type, 'notebook'),
      ),
    );
  if (!row) return null;
  const named = typeof row.content.sourceKey === 'string' ? row.content.sourceKey : null;
  return {
    revisionId,
    resourceId: row.resourceId,
    title: row.title,
    sourceKey: named && row.objectKeys.includes(named) ? named : null,
  };
}

/** The caller's working copy of a course notebook revision, if one was made. */
export async function findWorkingCopy(
  db: Executor,
  scope: ClassScope,
  sourceRevisionId: string,
): Promise<WorkingCopyRow | null> {
  const [row] = await db
    .select()
    .from(notebookWorkingCopies)
    .where(and(mine(scope), eq(notebookWorkingCopies.sourceRevisionId, sourceRevisionId)));
  return row ?? null;
}

/** One of the caller's working copies by id; null for anyone else's. */
export async function workingCopyById(
  db: Executor,
  scope: ClassScope,
  workingCopyId: string,
): Promise<WorkingCopyRow | null> {
  const [row] = await db
    .select()
    .from(notebookWorkingCopies)
    .where(and(mine(scope), eq(notebookWorkingCopies.id, workingCopyId)));
  return row ?? null;
}

/**
 * Makes the caller's working copy of a course notebook revision, revision 1 being `stored` (the
 * course notebook, source `server`), unless one exists; returns the working copy either way.
 * Two first Connects at once make one copy (the unique key decides).
 */
export async function createWorkingCopy(
  db: Db,
  scope: ClassScope,
  sourceRevisionId: string,
  stored: StoredObject,
  now: Date,
): Promise<WorkingCopyRow> {
  return db.transaction(async (tx) => {
    const [made] = await tx
      .insert(notebookWorkingCopies)
      .values({
        classId: scope.classId,
        userId: scope.user.id,
        sourceRevisionId,
        currentRevision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!made) {
      const existing = await findWorkingCopy(tx, scope, sourceRevisionId);
      if (!existing) throw new Error('working copy vanished after a conflicting insert');
      return existing;
    }
    await tx.insert(notebookWorkingCopyRevisions).values({
      workingCopyId: made.id,
      revision: 1,
      classId: scope.classId,
      objectKey: stored.key,
      sha256: stored.sha256,
      size: stored.size,
      source: 'server',
      createdAt: now,
    });
    return made;
  });
}

/** Ties one of the caller's sessions to its working copy (`notebook_sessions.working_copy_id`). */
export async function linkSessionWorkingCopy(
  db: Db,
  scope: ClassScope,
  sessionId: string,
  workingCopy: WorkingCopyRow,
): Promise<void> {
  await db
    .update(notebookSessions)
    .set({ workingCopyId: workingCopy.id })
    .where(
      and(
        forClass(scope, notebookSessions),
        eq(notebookSessions.userId, scope.user.id),
        eq(notebookSessions.id, sessionId),
        eq(notebookSessions.resourceRevisionId, workingCopy.sourceRevisionId),
      ),
    );
}

/** One revision of a working copy the caller holds (checked by the caller of this function). */
export async function workingCopyRevision(
  db: Executor,
  scope: ClassScope,
  workingCopy: WorkingCopyRow,
  revision: number,
): Promise<WorkingCopyRevisionRow | null> {
  const [row] = await db
    .select()
    .from(notebookWorkingCopyRevisions)
    .where(
      and(
        forClass(scope, notebookWorkingCopyRevisions),
        eq(notebookWorkingCopyRevisions.workingCopyId, workingCopy.id),
        eq(notebookWorkingCopyRevisions.revision, revision),
      ),
    );
  return row ?? null;
}

/** The working copy's revisions, newest first (at most 100). */
export function workingCopyRevisions(
  db: Executor,
  scope: ClassScope,
  workingCopy: WorkingCopyRow,
): Promise<WorkingCopyRevisionRow[]> {
  return db
    .select()
    .from(notebookWorkingCopyRevisions)
    .where(
      and(
        forClass(scope, notebookWorkingCopyRevisions),
        eq(notebookWorkingCopyRevisions.workingCopyId, workingCopy.id),
      ),
    )
    .orderBy(desc(notebookWorkingCopyRevisions.revision))
    .limit(100);
}

export type AppendResult =
  | { ok: true; workingCopy: WorkingCopyRow; revision: WorkingCopyRevisionRow }
  | { ok: false; reason: 'not_found' | 'class_archived' }
  | { ok: false; reason: 'revision_conflict'; workingCopy: WorkingCopyRow };

/**
 * Appends the next revision after `baseRevision` (ADR-0003): refused with `revision_conflict`
 * when the copy's current revision is another one, so nothing saved is overwritten. The row is
 * locked while the number is taken.
 */
export async function appendRevision(
  db: Db,
  scope: ClassScope,
  workingCopyId: string,
  input: { baseRevision: number; stored: StoredObject; source: 'browser' | 'import' },
  now: Date,
): Promise<AppendResult> {
  if (scope.archived) return { ok: false, reason: 'class_archived' };
  return db.transaction(async (tx) => {
    const [copy] = await tx
      .select()
      .from(notebookWorkingCopies)
      .where(and(mine(scope), eq(notebookWorkingCopies.id, workingCopyId)))
      .for('update');
    if (!copy) return { ok: false as const, reason: 'not_found' as const };
    if (copy.currentRevision !== input.baseRevision) {
      return { ok: false as const, reason: 'revision_conflict' as const, workingCopy: copy };
    }
    const next = copy.currentRevision + 1;
    const [revision] = await tx
      .insert(notebookWorkingCopyRevisions)
      .values({
        workingCopyId: copy.id,
        revision: next,
        classId: scope.classId,
        objectKey: input.stored.key,
        sha256: input.stored.sha256,
        size: input.stored.size,
        source: input.source,
        createdAt: now,
      })
      .returning();
    const [updated] = await tx
      .update(notebookWorkingCopies)
      .set({ currentRevision: next, updatedAt: now })
      .where(and(mine(scope), eq(notebookWorkingCopies.id, copy.id)))
      .returning();
    if (!revision || !updated) throw new Error('working copy revision insert returned no row');
    return { ok: true as const, workingCopy: updated, revision };
  });
}

/** A declared file resolved to the course object it names. */
export interface DeclaredObject {
  path: string;
  key: string;
  sha256: string;
  size: number;
}

/**
 * Resolves the files a course notebook declares (`metadata.parallax.files: [{ path, resourceId }]`)
 * to objects of the course: `resourceId` names a stored object of the course that the notebook
 * revision itself lists among its objects, so only material released with the notebook can reach
 * a workspace. Entries naming anything else are left out.
 */
export async function declaredObjects(
  db: Executor,
  scope: ClassScope,
  sourceRevisionId: string,
  entries: { path: string; resourceId: string }[],
): Promise<DeclaredObject[]> {
  if (entries.length === 0) return [];
  const [revision] = await db
    .select({ objectKeys: resourceRevisions.objectKeys })
    .from(resourceRevisions)
    .where(
      and(
        eq(resourceRevisions.id, sourceRevisionId),
        eq(resourceRevisions.courseId, scope.courseId),
        eq(resourceRevisions.type, 'notebook'),
      ),
    );
  if (!revision || revision.objectKeys.length === 0) return [];
  const objects = await db
    .select({
      id: storageObjects.id,
      key: storageObjects.key,
      sha256: storageObjects.sha256,
      size: storageObjects.size,
    })
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.courseId, scope.courseId),
        inArray(
          storageObjects.id,
          entries.map((e) => e.resourceId),
        ),
        inArray(storageObjects.key, revision.objectKeys),
      ),
    );
  const byId = new Map(objects.map((o) => [o.id, o]));
  return entries.flatMap((entry) => {
    const object = byId.get(entry.resourceId);
    return object
      ? [{ path: entry.path, key: object.key, sha256: object.sha256, size: object.size }]
      : [];
  });
}

/**
 * The resource a course notebook revision belongs to, and its title in the class's release when
 * it is there; null for a revision of another course or another type.
 */
export async function notebookResource(
  db: Executor,
  scope: ClassScope,
  revisionId: string,
): Promise<{ resourceId: string; title: string | null } | null> {
  const [row] = await db
    .select({ resourceId: resourceRevisions.resourceId })
    .from(resourceRevisions)
    .where(
      and(
        eq(resourceRevisions.id, revisionId),
        eq(resourceRevisions.courseId, scope.courseId),
        eq(resourceRevisions.type, 'notebook'),
      ),
    );
  if (!row) return null;
  const [named] = scope.releaseId
    ? await db
        .select({ title: releaseResources.title })
        .from(releaseResources)
        .where(
          and(
            eq(releaseResources.releaseId, scope.releaseId),
            eq(releaseResources.resourceId, row.resourceId),
          ),
        )
    : [];
  return { resourceId: row.resourceId, title: named?.title ?? null };
}
