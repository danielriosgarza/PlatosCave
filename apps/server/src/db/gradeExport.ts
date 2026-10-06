import { and, asc, desc, eq } from 'drizzle-orm';
import { type CsvCell, toCsv } from '../assessments/csv';
import type { ClassScope } from '../auth/scope';
import { audit } from './audit';
import type { Db } from './client';
import { classMemberships, grades, resources, testAttempts, users } from './schema';
import { forClass } from './scoped';
import { reviewable } from './tests';

/**
 * Results export (§12): one row per real student's test attempt of the scoped class, removed
 * students included, preview attempts never. The grade columns describe the attempt's newest
 * grade row (its state is `draft` or `released`, `none` before any grade), so a draft saved
 * over a released grade shows as `draft`.
 */
export const EXPORT_COLUMNS = [
  'course',
  'class',
  'assignment',
  'student',
  'attempt',
  'attempt_state',
  'grade_state',
  'points',
  'possible',
  'started_at',
  'submitted_at',
  'graded_at',
  'released_at',
] as const;

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function resultsCsv(
  db: Db,
  scope: ClassScope,
): Promise<{ csv: string; rows: number }> {
  const attempts = await db
    .select({ attempt: testAttempts, student: users.name, assignment: resources.title })
    .from(testAttempts)
    .innerJoin(users, eq(users.id, testAttempts.userId))
    .innerJoin(resources, eq(resources.id, testAttempts.resourceId))
    .leftJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, testAttempts.classId),
        eq(classMemberships.userId, testAttempts.userId),
      ),
    )
    .where(reviewable(scope))
    .orderBy(
      asc(resources.title),
      asc(resources.id),
      asc(users.name),
      asc(testAttempts.userId),
      asc(testAttempts.number),
    );
  const history = await db
    .select()
    .from(grades)
    .where(forClass(scope, grades))
    .orderBy(desc(grades.number));
  // Newest row first, so the first one seen per attempt is its current grade.
  const current = new Map<string, (typeof history)[number]>();
  for (const row of history) if (!current.has(row.attemptId)) current.set(row.attemptId, row);

  const rows: CsvCell[][] = attempts.map(({ attempt, student, assignment }) => {
    const grade = current.get(attempt.id);
    return [
      scope.courseTitle,
      scope.className,
      assignment,
      student,
      attempt.number,
      attempt.state,
      grade?.state ?? 'none',
      grade?.points ?? null,
      grade?.possible ?? null,
      iso(attempt.startedAt),
      iso(attempt.submittedAt),
      iso(grade?.createdAt ?? null),
      iso(grade?.releasedAt ?? null),
    ];
  });
  return { csv: toCsv(EXPORT_COLUMNS, rows), rows: rows.length };
}

/** Audit event of an export (§13), written once the file is stored. */
export async function recordResultsExport(
  db: Db,
  scope: ClassScope,
  file: { key: string; sha256: string; size: number; rows: number },
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
      after: file,
      createdAt: now,
    }),
  );
}
