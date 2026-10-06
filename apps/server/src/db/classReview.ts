import type * as contracts from '@parallax/contracts/routes/review';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import type { Db } from './client';
import { readClassRelease } from './content/releases';
import {
  classMemberships,
  exerciseAttempts,
  grades,
  notebookSubmissions,
  testAttempts,
  threads,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * The class review table (§12): real students of the class against the tests, exercises and
 * questions in scope. Preview principals and removed students are not listed. A filter narrows
 * the students (Needs review, one student) or the scope the columns count (topic, assignment).
 * Everything is read through the class scope, and the syllabus from the class's adopted release.
 */

export type ClassReview = z.input<typeof contracts.classReview>;
export type ReviewFilters = z.output<typeof contracts.reviewQuery>;
type Row = ClassReview['rows'][number];

/** Attempt states in which the instructor still has something to do (§11). */
const AWAITING = new Set(['submitted', 'grading', 'needs_review', 'graded']);

export async function loadClassReview(
  db: Db,
  scope: ClassScope,
  filters: ReviewFilters,
): Promise<ClassReview> {
  const { topics: releaseTopics } = await readClassRelease(db, scope);
  const topics = releaseTopics.map((t, i) => ({
    topicId: t.topicId,
    number: i + 1,
    title: t.title,
  }));
  const resources = releaseTopics.flatMap((t) =>
    t.resources.map((r) => ({
      resourceId: r.resourceId,
      tab: r.tab,
      title: r.title,
      topicId: t.topicId,
    })),
  );

  // An assignment outside the topic filter is no assignment of that view.
  const inTopic = (r: { topicId: string }) =>
    filters.topicId === undefined || r.topicId === filters.topicId;
  const assignments = resources
    .filter((r) => r.tab === 'tests')
    .map((r) => ({ assignmentId: r.resourceId, title: r.title, topicId: r.topicId }));
  const assignment =
    assignments.find((a) => a.assignmentId === filters.assignmentId && inTopic(a)) ?? null;
  const exerciseIds = new Set(
    resources.filter((r) => r.tab === 'exercises' && inTopic(r)).map((r) => r.resourceId),
  );
  const testIds = new Set(
    assignments
      .filter((a) => (assignment ? a === assignment : inTopic(a)))
      .map((a) => a.assignmentId),
  );
  const resourceIdsInTopic = new Set(resources.filter(inTopic).map((r) => r.resourceId));

  const roster = await db
    .select({ id: users.id, name: users.name })
    .from(classMemberships)
    .innerJoin(users, eq(users.id, classMemberships.userId))
    .where(
      and(
        forClass(scope, classMemberships),
        eq(classMemberships.role, 'student'),
        eq(classMemberships.isPreview, false),
      ),
    )
    .orderBy(asc(users.name), asc(users.id));
  const studentIds = new Set(roster.map((s) => s.id));

  const [allAttempts, completed, questions, notebooks] = await Promise.all([
    db
      .select()
      .from(testAttempts)
      .where(and(forClass(scope, testAttempts), eq(testAttempts.isPreview, false)))
      .orderBy(desc(testAttempts.number)),
    db
      .select({ userId: exerciseAttempts.userId, resourceId: exerciseAttempts.resourceId })
      .from(exerciseAttempts)
      .where(
        and(
          forClass(scope, exerciseAttempts),
          eq(exerciseAttempts.isPreview, false),
          isNotNull(exerciseAttempts.completedAt),
        ),
      ),
    db
      .select({ authorId: threads.authorId, resourceId: threads.resourceId })
      .from(threads)
      .where(
        and(forClass(scope, threads), eq(threads.isPreview, false), eq(threads.status, 'open')),
      ),
    db
      .select({ userId: notebookSubmissions.userId, at: notebookSubmissions.createdAt })
      .from(notebookSubmissions)
      .where(and(forClass(scope, notebookSubmissions), eq(notebookSubmissions.isPreview, false)))
      .orderBy(desc(notebookSubmissions.createdAt)),
  ]);
  const attempts = allAttempts.filter((a) => studentIds.has(a.userId));
  const gradeRows = attempts.length
    ? await db
        .select()
        .from(grades)
        .where(
          and(
            forClass(scope, grades),
            inArray(
              grades.attemptId,
              attempts.map((a) => a.id),
            ),
          ),
        )
        .orderBy(desc(grades.number))
    : [];
  const newest = new Map<string, (typeof gradeRows)[number]>();
  const released = new Map<string, (typeof gradeRows)[number]>();
  for (const g of gradeRows) {
    if (!newest.has(g.attemptId)) newest.set(g.attemptId, g);
    if (g.state === 'released' && !released.has(g.attemptId)) released.set(g.attemptId, g);
  }

  const attemptsOf = groupBy(attempts, (a) => a.userId);
  const doneOf = groupBy(
    completed.filter((c) => exerciseIds.has(c.resourceId)),
    (c) => c.userId,
  );
  const questionsOf = groupBy(
    questions.filter((q) => resourceIdsInTopic.has(q.resourceId)),
    (q) => q.authorId,
  );
  const lastNotebook = new Map<string, Date>();
  for (const n of notebooks) if (!lastNotebook.has(n.userId)) lastNotebook.set(n.userId, n.at);

  const all: Row[] = roster.map((s) => {
    const mine = attemptsOf.get(s.id) ?? [];
    const inScope = mine.filter((a) => testIds.has(a.resourceId));
    const submitted = inScope.filter((a) => a.state !== 'in_progress');
    const latest = assignment ? inScope[0] : undefined;
    const grade = latest && (released.get(latest.id) ?? newest.get(latest.id));
    const lastTest = mine
      .map((a) => a.submittedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const notebook = lastNotebook.get(s.id);
    const lastKind = lastTest && (!notebook || lastTest >= notebook) ? 'test' : 'notebook';
    const last = lastKind === 'test' ? lastTest : notebook;
    return {
      studentId: s.id,
      name: s.name,
      exercises: {
        completed: new Set((doneOf.get(s.id) ?? []).map((c) => c.resourceId)).size,
        total: exerciseIds.size,
      },
      tests: {
        submitted: new Set(submitted.map((a) => a.resourceId)).size,
        released: new Set(submitted.filter((a) => a.state === 'released').map((a) => a.resourceId))
          .size,
        total: testIds.size,
      },
      attempt: latest
        ? {
            attemptId: latest.id,
            number: latest.number,
            state: latest.state,
            submittedAt: latest.submittedAt?.toISOString() ?? null,
            score: grade
              ? { points: grade.points, possible: grade.possible, state: grade.state }
              : null,
          }
        : null,
      needsReview: inScope.some((a) => AWAITING.has(a.state)),
      openQuestions: (questionsOf.get(s.id) ?? []).length,
      lastSubmission: last ? { at: last.toISOString(), kind: lastKind } : null,
    };
  });

  const filtered = all.filter(
    (r) =>
      (filters.studentId === undefined || r.studentId === filters.studentId) &&
      (!filters.needsReview || r.needsReview),
  );
  // A page past the end (a stale link, or Needs review shrinking the list) shows the last page.
  const page = Math.min(filters.page, Math.max(1, Math.ceil(filtered.length / filters.pageSize)));
  const start = (page - 1) * filters.pageSize;
  const selectedAttempt = filters.attemptId
    ? attempts.find((a) => a.id === filters.attemptId)
    : undefined;
  return {
    topics,
    assignments,
    roster,
    students: filtered.map((r) => ({
      id: r.studentId,
      name: r.name,
      attempt: r.attempt && { attemptId: r.attempt.attemptId, number: r.attempt.number },
    })),
    total: filtered.length,
    page,
    pageSize: filters.pageSize,
    rows: filtered.slice(start, start + filters.pageSize),
    assignment: assignment && { assignmentId: assignment.assignmentId, title: assignment.title },
    selected: selectedAttempt
      ? {
          studentId: selectedAttempt.userId,
          attemptId: selectedAttempt.id,
          number: selectedAttempt.number,
          assignmentId: selectedAttempt.resourceId,
        }
      : null,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}
