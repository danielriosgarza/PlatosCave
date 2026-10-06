import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type CsvCell, toCsv } from '../assessments/csv';
import type { ClassScope } from '../auth/scope';
import { classExportPrefix, objectKey } from '../storage/storage';
import { audit } from './audit';
import type { Db } from './client';
import { classMemberships, grades, releaseResources, testAttempts, users } from './schema';
import { forClass } from './scoped';
import { reviewable, settleClassDue } from './tests';

/**
 * Results export (§12): one row per real student's test attempt of the scoped class, removed
 * students included, preview attempts never. Overdue attempts are settled first, as the review
 * reads do, and the assignment is titled as the class's adopted release titles it, never the
 * course draft (A26). The grade columns describe the attempt's newest grade row (`draft` or
 * `released`, `none` before any grade) and whether it is complete; `released_points` and
 * `released_at` carry what the student sees, which a newer draft does not change.
 */
export const EXPORT_COLUMNS = [
  'course',
  'class',
  'assignment',
  'student',
  'attempt',
  'attempt_state',
  'grade_state',
  'grade_complete',
  'points',
  'possible',
  'started_at',
  'submitted_at',
  'graded_at',
  'released_points',
  'released_at',
] as const;

/** Excel reads a BOM-less CSV in the system code page and garbles non-ASCII names. */
const BOM = '﻿';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export interface ResultsFile {
  body: Buffer;
  key: string;
  sha256: string;
  rows: number;
}

/** Titles the class sees: the adopted release's, else the release that holds the pinned revision. */
async function titlesOf(
  db: Db,
  scope: ClassScope,
  attempts: { resourceId: string; resourceRevisionId: string }[],
) {
  const byResource = new Map<string, string>();
  if (scope.releaseId) {
    const adopted = await db
      .select({ resourceId: releaseResources.resourceId, title: releaseResources.title })
      .from(releaseResources)
      .where(eq(releaseResources.releaseId, scope.releaseId));
    for (const r of adopted) byResource.set(r.resourceId, r.title);
  }
  // A resource dropped from the adopted release keeps the title of the revision attempts pinned.
  const missing = [
    ...new Set(
      attempts.filter((a) => !byResource.has(a.resourceId)).map((a) => a.resourceRevisionId),
    ),
  ];
  const byRevision = new Map<string, string>();
  if (missing.length > 0) {
    const pinned = await db
      .select({
        revisionId: releaseResources.resourceRevisionId,
        title: releaseResources.title,
      })
      .from(releaseResources)
      .where(inArray(releaseResources.resourceRevisionId, missing))
      .orderBy(asc(releaseResources.releaseId));
    for (const r of pinned)
      if (!byRevision.has(r.revisionId)) byRevision.set(r.revisionId, r.title);
  }
  return (a: { resourceId: string; resourceRevisionId: string }) =>
    byResource.get(a.resourceId) ?? byRevision.get(a.resourceRevisionId) ?? '';
}

export async function resultsFile(db: Db, scope: ClassScope, now: Date): Promise<ResultsFile> {
  await settleClassDue(db, scope, now);
  const found = await db
    .select({ attempt: testAttempts, student: users.name })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(reviewable(scope));
  const titleOf = await titlesOf(
    db,
    scope,
    found.map((f) => f.attempt),
  );
  const ofClass = forClass(scope, grades);
  const columns = {
    attemptId: grades.attemptId,
    state: grades.state,
    complete: grades.complete,
    points: grades.points,
    possible: grades.possible,
    createdAt: grades.createdAt,
    releasedAt: grades.releasedAt,
  };
  const newest = await db
    .selectDistinctOn([grades.attemptId], columns)
    .from(grades)
    .where(ofClass)
    .orderBy(grades.attemptId, desc(grades.number));
  const released = await db
    .selectDistinctOn([grades.attemptId], columns)
    .from(grades)
    .where(and(ofClass, eq(grades.state, 'released')))
    .orderBy(grades.attemptId, desc(grades.number));
  const current = new Map(newest.map((g) => [g.attemptId, g]));
  const seen = new Map(released.map((g) => [g.attemptId, g]));

  const rows = found
    .map(({ attempt, student }) => ({ attempt, student, assignment: titleOf(attempt) }))
    .sort(
      (a, b) =>
        a.assignment.localeCompare(b.assignment) ||
        a.attempt.resourceId.localeCompare(b.attempt.resourceId) ||
        a.student.localeCompare(b.student) ||
        a.attempt.userId.localeCompare(b.attempt.userId) ||
        a.attempt.number - b.attempt.number,
    )
    .map(({ attempt, student, assignment }): CsvCell[] => {
      const grade = current.get(attempt.id);
      const shown = seen.get(attempt.id);
      return [
        scope.courseTitle,
        scope.className,
        assignment,
        student,
        attempt.number,
        attempt.state,
        grade?.state ?? 'none',
        grade ? (grade.complete ? 'yes' : 'no') : null,
        grade?.points ?? null,
        grade?.possible ?? null,
        iso(attempt.startedAt),
        iso(attempt.submittedAt),
        iso(grade?.createdAt ?? null),
        shown?.points ?? null,
        iso(shown?.releasedAt ?? null),
      ];
    });
  const body = Buffer.from(BOM + toCsv(EXPORT_COLUMNS, rows), 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  return {
    body,
    sha256,
    key: objectKey(classExportPrefix(scope.classId), sha256),
    rows: rows.length,
  };
}

/** Audit event of an export (§13), written before the file is stored so no file lacks one. */
export async function recordResultsExport(
  db: Db,
  scope: ClassScope,
  file: ResultsFile,
  now: Date,
): Promise<void> {
  await db.transaction((tx) =>
    audit(tx, {
      actorId: scope.user.id,
      action: 'export.results',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      after: { key: file.key, sha256: file.sha256, size: file.body.length, rows: file.rows },
      createdAt: now,
    }),
  );
}
