import type * as contracts from '@parallax/contracts/routes/notebookSubmissions';
import { and, asc, desc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
import type { StoredObject } from '../storage/storage';
import { audit } from './audit';
import type { Db, Executor } from './client';
import { studyableResource } from './content/releases';
import { excludePreview } from './preview';
import { studentOrRemovedStudent } from './removedStudents';
import {
  auditEvents,
  classMemberships,
  notebookSubmissionFiles,
  notebookSubmissions,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * Notebook submissions of one class (§10.5, §13). Every function takes the resolved `ClassScope`:
 * a student reads and writes their own submissions, and an instructor reads every student's
 * through `reviewSubmissions` and `submissionObject`. Preview principals write rows flagged
 * `is_preview`, which review never lists.
 */

type Receipt = z.input<typeof contracts.submissionReceipt>;
type Reviewed = z.input<typeof contracts.reviewedSubmission>;
type Row = typeof notebookSubmissions.$inferSelect;
type FileRow = typeof notebookSubmissionFiles.$inferSelect;

const receipt = (row: Row, files: FileRow[] = []): Receipt => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceRevisionId: row.resourceRevisionId,
  version: row.version,
  filename: row.filename,
  size: row.size,
  sha256: row.sha256,
  environment: row.environment,
  receivedAt: row.createdAt.toISOString(),
  ...(row.workingCopyRevision !== null && {
    workingCopyRevision: row.workingCopyRevision,
    files: files
      .filter((f) => f.submissionId === row.id)
      .map((f) => ({ id: f.fileTransferId, path: f.path, size: f.size, sha256: f.sha256 })),
  }),
});

/** The frozen files of `rows`, read in one query. */
async function filesOf(db: Executor, scope: ClassScope, rows: Row[]): Promise<FileRow[]> {
  const ids = rows.filter((r) => r.workingCopyRevision !== null).map((r) => r.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(notebookSubmissionFiles)
    .where(
      and(
        forClass(scope, notebookSubmissionFiles),
        inArray(notebookSubmissionFiles.submissionId, ids),
      ),
    )
    .orderBy(asc(notebookSubmissionFiles.path));
}

const own = (scope: ClassScope) =>
  and(forClass(scope, notebookSubmissions), eq(notebookSubmissions.userId, scope.user.id));

/** The notebook the caller may study now; the pinned revision is read again when recording. */
export async function submittableNotebook(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<{ ok: true; value: { revisionId: string } } | typeof notFound | typeof classArchived> {
  const resource = await studyableResource(db, scope, resourceId, now);
  if (resource?.type !== 'notebook') return notFound;
  if (scope.archived) return classArchived;
  return { ok: true, value: { revisionId: resource.revisionId } };
}

/** Launches by one person of one notebook inside this window are one audit row. */
const COLAB_LAUNCH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Records that the caller opened Colab for a notebook. A preview records nothing. A launch within
 * `COLAB_LAUNCH_WINDOW_MS` of the caller's last one for the notebook adds no row and answers that
 * launch's time, so repeated clicks do not grow the audit trail.
 */
export async function recordColabLaunch(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<{ launchedAt: string | null }>> {
  const found = await submittableNotebook(db, scope, resourceId, now);
  if (!found.ok) return found;
  if (scope.membership.isPreview) return { ok: true, value: { launchedAt: null } };
  return db.transaction(async (tx) => {
    // Serialises one person's launches of one notebook, so two clicks never both add a row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`colab:${scope.user.id}:${resourceId}`}))`,
    );
    const [last] = await tx
      .select({ createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'notebook.colab_launched'),
          eq(auditEvents.actorId, scope.user.id),
          eq(auditEvents.scopeId, scope.classId),
          eq(auditEvents.targetId, resourceId),
          gt(auditEvents.createdAt, new Date(now.getTime() - COLAB_LAUNCH_WINDOW_MS)),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    if (last) return { ok: true as const, value: { launchedAt: last.createdAt.toISOString() } };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'notebook.colab_launched',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'resource',
      targetId: resourceId,
      createdAt: now,
    });
    return { ok: true as const, value: { launchedAt: now.toISOString() } };
  });
}

export interface NewSubmission {
  submissionKey: string;
  filename: string;
  stored: StoredObject;
  environment: Record<string, string | number>;
  /**
   * A submission from a connected session (P3-09): the acknowledged working-copy revision, the
   * course notebook revision it was made from (pinned instead of the class's current one), the
   * session whose environment is recorded, and the finished copy-outs to freeze with it.
   */
  connected?: {
    workingCopyId: string;
    workingCopyRevision: number;
    sourceRevisionId: string;
    sessionId: string;
    files: { transferId: string; path: string; sha256: string; size: number; objectKey: string }[];
  };
}

/**
 * Freezes an uploaded and acknowledged file as the next version of the caller's submission of
 * this notebook. The same `submissionKey` with the same file answers the existing receipt and
 * adds nothing; with another file it is refused. Versions are numbered under a lock on the
 * caller's submissions of the notebook, so two requests never take the same number.
 */
export async function recordSubmission(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  input: NewSubmission,
  now: Date,
): Promise<Outcome<Receipt>> {
  const found = await submittableNotebook(db, scope, resourceId, now);
  if (!found.ok) return found;
  return db.transaction(async (tx) => {
    const lock = `notebook-submission:${scope.classId}:${scope.user.id}:${resourceId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const [existing] = await tx
      .select()
      .from(notebookSubmissions)
      .where(
        and(
          own(scope),
          eq(notebookSubmissions.resourceId, resourceId),
          eq(notebookSubmissions.submissionKey, input.submissionKey),
        ),
      );
    if (existing) {
      if (existing.sha256 !== input.stored.sha256) {
        return invalid('This submission key was already used for a different file');
      }
      return { ok: true, value: receipt(existing, await filesOf(tx, scope, [existing])) };
    }
    const [latest] = await tx
      .select({ version: max(notebookSubmissions.version) })
      .from(notebookSubmissions)
      .where(and(own(scope), eq(notebookSubmissions.resourceId, resourceId)));
    const [row] = await tx
      .insert(notebookSubmissions)
      .values({
        classId: scope.classId,
        userId: scope.user.id,
        isPreview: scope.membership.isPreview,
        resourceId,
        resourceRevisionId: input.connected?.sourceRevisionId ?? found.value.revisionId,
        version: (latest?.version ?? 0) + 1,
        submissionKey: input.submissionKey,
        objectKey: input.stored.key,
        sha256: input.stored.sha256,
        size: input.stored.size,
        filename: input.filename,
        environment: input.environment,
        ...(input.connected && {
          workingCopyId: input.connected.workingCopyId,
          workingCopyRevision: input.connected.workingCopyRevision,
          sessionId: input.connected.sessionId,
        }),
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('notebook submission insert returned no row');
    const files = input.connected?.files.length
      ? await tx
          .insert(notebookSubmissionFiles)
          .values(
            input.connected.files.map((f) => ({
              submissionId: row.id,
              path: f.path,
              classId: scope.classId,
              fileTransferId: f.transferId,
              sha256: f.sha256,
              size: f.size,
              objectKey: f.objectKey,
            })),
          )
          .returning()
      : [];
    if (!scope.membership.isPreview) {
      await audit(tx, {
        actorId: scope.user.id,
        action: 'notebook.submitted',
        scopeKind: 'class',
        scopeId: scope.classId,
        targetType: 'notebook_submission',
        targetId: row.id,
        after: {
          resourceId,
          version: row.version,
          sha256: row.sha256,
          ...(input.connected && {
            workingCopyRevision: input.connected.workingCopyRevision,
            files: files.length,
          }),
        },
        createdAt: now,
      });
    }
    return { ok: true, value: receipt(row, files) };
  });
}

/** The caller's own submissions of a notebook, newest version first. */
export async function listOwnSubmissions(
  db: Db,
  scope: ClassScope,
  resourceId: string,
): Promise<Receipt[]> {
  const rows = await db
    .select()
    .from(notebookSubmissions)
    .where(and(own(scope), eq(notebookSubmissions.resourceId, resourceId)))
    .orderBy(desc(notebookSubmissions.version));
  const files = await filesOf(db, scope, rows);
  return rows.map((row) => receipt(row, files));
}

/** Every student's submissions of a notebook, by student name and newest version first. */
export async function reviewSubmissions(
  db: Db,
  scope: ClassScope,
  resourceId: string,
): Promise<Reviewed[]> {
  const rows = await db
    .select({ submission: notebookSubmissions, name: users.name, role: classMemberships.role })
    .from(notebookSubmissions)
    .innerJoin(users, eq(users.id, notebookSubmissions.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, notebookSubmissions.classId),
        eq(classMemberships.userId, notebookSubmissions.userId),
      ),
    )
    .where(
      and(
        forClass(scope, notebookSubmissions),
        eq(notebookSubmissions.resourceId, resourceId),
        excludePreview(notebookSubmissions),
        studentOrRemovedStudent(notebookSubmissions),
      ),
    )
    .orderBy(asc(users.name), asc(notebookSubmissions.userId), desc(notebookSubmissions.version));
  const files = await filesOf(
    db,
    scope,
    rows.map((r) => r.submission),
  );
  return rows.map(({ submission, name, role }) => ({
    ...receipt(submission, files),
    student: { id: submission.userId, name },
    removed: role === null,
  }));
}

/**
 * The stored snapshot of one submission the caller may download: their own, or any real
 * student's for an instructor. Others' submissions look like missing ones.
 */
export async function submissionObject(
  db: Db,
  scope: ClassScope,
  submissionId: string,
): Promise<{ key: string; filename: string } | null> {
  const [row] = await db
    .select()
    .from(notebookSubmissions)
    .where(and(forClass(scope, notebookSubmissions), eq(notebookSubmissions.id, submissionId)));
  if (!row) return null;
  const mine = row.userId === scope.user.id;
  const reviewable = scope.role === 'instructor' && !row.isPreview;
  return mine || reviewable ? { key: row.objectKey, filename: row.filename } : null;
}

/**
 * One file frozen with a submission the caller may download (as `submissionObject` decides),
 * named by the copy-out it came from; null otherwise.
 */
export async function submissionFileObject(
  db: Db,
  scope: ClassScope,
  submissionId: string,
  fileId: string,
): Promise<{ key: string; path: string } | null> {
  if (!(await submissionObject(db, scope, submissionId))) return null;
  const [file] = await db
    .select()
    .from(notebookSubmissionFiles)
    .where(
      and(
        forClass(scope, notebookSubmissionFiles),
        eq(notebookSubmissionFiles.submissionId, submissionId),
        eq(notebookSubmissionFiles.fileTransferId, fileId),
      ),
    );
  return file ? { key: file.objectKey, path: file.path } : null;
}
