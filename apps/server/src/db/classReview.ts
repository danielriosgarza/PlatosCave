import type * as contracts from '@parallax/contracts/routes/review';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { ClassScope } from '../auth/scope';
import type { Db } from './client';
import {
  classMemberships,
  exerciseAttempts,
  grades,
  notebookSubmissions,
  releaseResources,
  releaseTopics,
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
  const syllabus = await syllabusOf(db, scope);
  const topics = syllabus.topics.map((t, i) => ({
    topicId: t.topicId,
    number: i + 1,
    title: t.title,
  }));

  const assignments = syllabus.resources
    .filter((r) => r.tab === 'tests')
    .map((r) => ({ assignmentId: r.resourceId, title: r.title, topicId: r.topicId }));
  const assignment = assignments.find((a) => a.assignmentId === filters.assignmentId) ?? null;
  const topicId = filters.topicId ?? assignment?.topicId;
  const inTopic = (r: { topicId: string }) => topicId === undefined || r.topicId === topicId;
  const exerciseIds = new Set(
    syllabus.resources.filter((r) => r.tab === 'exercises' && inTopic(r)).map((r) => r.resourceId),
  );
  const testIds = new Set(
    assignments
      .filter((a) => (assignment ? a === assignment : inTopic(a)))
      .map((a) => a.assignmentId),
  );
  const resourceIdsInTopic = new Set(syllabus.resources.filter(inTopic).map((r) => r.resourceId));

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
  const students = new Set(roster.map((s) => s.id));

  const attempts = (
    await db
      .select()
      .from(testAttempts)
      .where(and(forClass(scope, testAttempts), eq(testAttempts.isPreview, false)))
      .orderBy(desc(testAttempts.number))
  ).filter((a) => students.has(a.userId));
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

  const completed = await db
    .select({
      userId: exerciseAttempts.userId,
      resourceId: exerciseAttempts.resourceId,
      at: exerciseAttempts.completedAt,
    })
    .from(exerciseAttempts)
    .where(and(forClass(scope, exerciseAttempts), eq(exerciseAttempts.isPreview, false)));

  const questions = await db
    .select({ authorId: threads.authorId, resourceId: threads.resourceId })
    .from(threads)
    .where(and(forClass(scope, threads), eq(threads.isPreview, false), eq(threads.status, 'open')));

  const notebooks = await db
    .select({
      userId: notebookSubmissions.userId,
      at: notebookSubmissions.createdAt,
    })
    .from(notebookSubmissions)
    .where(and(forClass(scope, notebookSubmissions), eq(notebookSubmissions.isPreview, false)))
    .orderBy(desc(notebookSubmissions.createdAt));

  const all: Row[] = roster.map((s) => {
    const mine = attempts.filter((a) => a.userId === s.id);
    const inScope = mine.filter((a) => testIds.has(a.resourceId));
    const submitted = inScope.filter((a) => a.state !== 'in_progress');
    const tests = new Set(submitted.map((a) => a.resourceId));
    const done = new Set(
      completed
        .filter((c) => c.userId === s.id && c.at !== null && exerciseIds.has(c.resourceId))
        .map((c) => c.resourceId),
    );
    const latest = assignment ? inScope[0] : undefined;
    const grade = latest && (released.get(latest.id) ?? newest.get(latest.id));
    const lastTest = mine
      .map((a) => a.submittedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const lastNotebook = notebooks.find((n) => n.userId === s.id)?.at;
    const lastKind = lastTest && (!lastNotebook || lastTest >= lastNotebook) ? 'test' : 'notebook';
    const last = lastKind === 'test' ? lastTest : lastNotebook;
    return {
      studentId: s.id,
      name: s.name,
      exercises: { completed: done.size, total: exerciseIds.size },
      tests: {
        submitted: tests.size,
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
      openQuestions: questions.filter(
        (q) => q.authorId === s.id && resourceIdsInTopic.has(q.resourceId),
      ).length,
      lastSubmission: last ? { at: last.toISOString(), kind: lastKind } : null,
    };
  });

  const filtered = all.filter(
    (r) =>
      (filters.studentId === undefined || r.studentId === filters.studentId) &&
      (!filters.needsReview || r.needsReview),
  );
  const start = (filters.page - 1) * filters.pageSize;
  const selectedAttempt = filters.attemptId
    ? attempts.find((a) => a.id === filters.attemptId)
    : undefined;
  return {
    topics,
    assignments,
    roster,
    students: filtered.map((r) => ({ id: r.studentId, name: r.name })),
    total: filtered.length,
    page: filters.page,
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

/** Topics and resources of the class's adopted release; empty before one is adopted. */
async function syllabusOf(db: Db, scope: ClassScope) {
  if (!scope.releaseId) return { topics: [], resources: [] };
  const topics = await db
    .select({ id: releaseTopics.id, topicId: releaseTopics.topicId, title: releaseTopics.title })
    .from(releaseTopics)
    .where(eq(releaseTopics.releaseId, scope.releaseId))
    .orderBy(asc(releaseTopics.position));
  const rows = await db
    .select({
      releaseTopicId: releaseResources.releaseTopicId,
      resourceId: releaseResources.resourceId,
      tab: releaseResources.tab,
      title: releaseResources.title,
    })
    .from(releaseResources)
    .where(eq(releaseResources.releaseId, scope.releaseId))
    .orderBy(asc(releaseResources.position));
  const topicOf = new Map(topics.map((t) => [t.id, t.topicId]));
  return {
    topics,
    resources: rows.flatMap((r) => {
      const topicId = topicOf.get(r.releaseTopicId);
      return topicId ? [{ ...r, topicId }] : [];
    }),
  };
}
