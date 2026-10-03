import type * as contracts from '@parallax/contracts/routes/notebookSubmissions';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import { classArchived, invalid, notFound, type Outcome } from '../outcome';
import type { StoredObject } from '../storage/storage';
import type { Db } from './client';
import { studyableResource } from './content/releases';
import { excludePreview } from './preview';
import { auditEvents, classMemberships, notebookSubmissions, users } from './schema';
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

const receipt = (row: Row): Receipt => ({
  id: row.id,
  resourceId: row.resourceId,
  resourceRevisionId: row.resourceRevisionId,
  version: row.version,
  filename: row.filename,
  size: row.size,
  sha256: row.sha256,
  environment: row.environment,
  receivedAt: row.createdAt.toISOString(),
});

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

/** Records that the caller opened Colab for a notebook. A preview records nothing. */
export async function recordColabLaunch(
  db: Db,
  scope: ClassScope,
  resourceId: string,
  now: Date,
): Promise<Outcome<{ launchedAt: string | null }>> {
  const found = await submittableNotebook(db, scope, resourceId, now);
  if (!found.ok) return found;
  if (scope.membership.isPreview) return { ok: true, value: { launchedAt: null } };
  await db.insert(auditEvents).values({
    actorId: scope.user.id,
    action: 'notebook.colab_launched',
    scopeKind: 'class',
    scopeId: scope.classId,
    targetType: 'resource',
    targetId: resourceId,
    createdAt: now,
  });
  return { ok: true, value: { launchedAt: now.toISOString() } };
}

export interface NewSubmission {
  submissionKey: string;
  filename: string;
  stored: StoredObject;
  environment: Record<string, string | number>;
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
      return { ok: true, value: receipt(existing) };
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
        resourceRevisionId: found.value.revisionId,
        version: (latest?.version ?? 0) + 1,
        submissionKey: input.submissionKey,
        objectKey: input.stored.key,
        sha256: input.stored.sha256,
        size: input.stored.size,
        filename: input.filename,
        environment: input.environment,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('notebook submission insert returned no row');
    if (!scope.membership.isPreview) {
      await tx.insert(auditEvents).values({
        actorId: scope.user.id,
        action: 'notebook.submitted',
        scopeKind: 'class',
        scopeId: scope.classId,
        targetType: 'notebook_submission',
        targetId: row.id,
        after: { resourceId, version: row.version, sha256: row.sha256 },
        createdAt: now,
      });
    }
    return { ok: true, value: receipt(row) };
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
  return rows.map(receipt);
}

/** Every student's submissions of a notebook, by student name and newest version first. */
export async function reviewSubmissions(
  db: Db,
  scope: ClassScope,
  resourceId: string,
): Promise<Reviewed[]> {
  const rows = await db
    .select({ submission: notebookSubmissions, name: users.name })
    .from(notebookSubmissions)
    .innerJoin(users, eq(users.id, notebookSubmissions.userId))
    .innerJoin(
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
        eq(classMemberships.role, 'student'),
      ),
    )
    .orderBy(asc(users.name), asc(notebookSubmissions.userId), desc(notebookSubmissions.version));
  return rows.map(({ submission, name }) => ({
    ...receipt(submission),
    student: { id: submission.userId, name },
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
