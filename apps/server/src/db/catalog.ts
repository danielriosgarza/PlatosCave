import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { UserScope } from '../auth/scope';
import type { Db } from './client';
import { createCourse } from './identity';
import {
  classes,
  classMemberships,
  courseMemberships,
  courses,
  releaseResources,
  releaseTopics,
  resourceRevisions,
  studyPositions,
  topics,
} from './schema';

/**
 * The course cards of one person (§4): every class they belong to and every course they hold a
 * grant on, with counts and the saved resume location. All of it starts from the signed-in
 * user's own memberships; nothing is read for a class or course they are not in. Preview
 * principals are not contexts of their owner and are left out.
 */
export async function listCourseCards(db: Db, scope: UserScope) {
  const userId = scope.user.id;
  const classRows = await db
    .select({
      classId: classes.id,
      className: classes.name,
      courseId: courses.id,
      courseTitle: courses.title,
      role: classMemberships.role,
      archivedAt: classes.archivedAt,
      releaseId: classes.releaseId,
    })
    .from(classMemberships)
    .innerJoin(classes, eq(classes.id, classMemberships.classId))
    .innerJoin(courses, eq(courses.id, classes.courseId))
    .where(and(eq(classMemberships.userId, userId), eq(classMemberships.isPreview, false)))
    .orderBy(courses.title, classes.name);

  const releaseIds = [...new Set(classRows.flatMap((c) => (c.releaseId ? [c.releaseId] : [])))];
  const topicCounts = new Map<string, number>();
  if (releaseIds.length > 0) {
    const rows = await db
      .select({ releaseId: releaseTopics.releaseId, n: count() })
      .from(releaseTopics)
      .where(inArray(releaseTopics.releaseId, releaseIds))
      .groupBy(releaseTopics.releaseId);
    for (const r of rows) topicCounts.set(r.releaseId, r.n);
  }

  const taughtIds = classRows.filter((c) => c.role === 'instructor').map((c) => c.classId);
  const studentCounts = new Map<string, number>();
  if (taughtIds.length > 0) {
    const rows = await db
      .select({ classId: classMemberships.classId, n: count() })
      .from(classMemberships)
      .where(
        and(
          inArray(classMemberships.classId, taughtIds),
          eq(classMemberships.role, 'student'),
          eq(classMemberships.isPreview, false),
        ),
      )
      .groupBy(classMemberships.classId);
    for (const r of rows) studentCounts.set(r.classId, r.n);
  }

  // The newest saved position per class, shown against the class's adopted release.
  const studyingIds = classRows.filter((c) => c.role === 'student').map((c) => c.classId);
  const resumeByClass = new Map<string, Resume>();
  if (studyingIds.length > 0) {
    const positions = await db
      .select({
        classId: studyPositions.classId,
        tab: studyPositions.tab,
        resourceId: resourceRevisions.resourceId,
      })
      .from(studyPositions)
      .innerJoin(resourceRevisions, eq(resourceRevisions.id, studyPositions.resourceRevisionId))
      .where(and(eq(studyPositions.userId, userId), inArray(studyPositions.classId, studyingIds)))
      .orderBy(desc(studyPositions.updatedAt));
    const releaseOf = new Map(classRows.map((c) => [c.classId, c.releaseId]));
    for (const p of positions) {
      if (resumeByClass.has(p.classId)) continue;
      const releaseId = releaseOf.get(p.classId);
      if (!releaseId) continue;
      const [found] = await db
        .select({
          topicId: releaseTopics.topicId,
          topicTitle: releaseTopics.title,
          resourceTitle: releaseResources.title,
        })
        .from(releaseResources)
        .innerJoin(releaseTopics, eq(releaseTopics.id, releaseResources.releaseTopicId))
        .where(
          and(
            eq(releaseResources.releaseId, releaseId),
            eq(releaseResources.resourceId, p.resourceId),
          ),
        );
      // A position whose resource the adopted release no longer carries cannot be resumed.
      if (found) resumeByClass.set(p.classId, { ...found, tab: p.tab });
    }
  }

  const courseRows = await db
    .select({
      courseId: courses.id,
      title: courses.title,
      owner: courseMemberships.owner,
      editor: courseMemberships.editor,
      publisher: courseMemberships.publisher,
    })
    .from(courseMemberships)
    .innerJoin(courses, eq(courses.id, courseMemberships.courseId))
    .where(eq(courseMemberships.userId, userId))
    .orderBy(courses.title);
  const courseIds = courseRows.map((c) => c.courseId);
  const draftTopics = new Map<string, number>();
  const classTotals = new Map<string, number>();
  if (courseIds.length > 0) {
    for (const r of await db
      .select({ courseId: topics.courseId, n: count() })
      .from(topics)
      .where(and(inArray(topics.courseId, courseIds), isNull(topics.archivedAt)))
      .groupBy(topics.courseId)) {
      draftTopics.set(r.courseId, r.n);
    }
    for (const r of await db
      .select({ courseId: classes.courseId, n: count() })
      .from(classes)
      .where(inArray(classes.courseId, courseIds))
      .groupBy(classes.courseId)) {
      classTotals.set(r.courseId, r.n);
    }
  }

  return {
    classes: classRows.map((c) => {
      const total = c.releaseId ? (topicCounts.get(c.releaseId) ?? 0) : 0;
      const student = c.role === 'student';
      return {
        classId: c.classId,
        className: c.className,
        courseId: c.courseId,
        courseTitle: c.courseTitle,
        role: c.role,
        archived: c.archivedAt !== null,
        topicCount: total,
        reviewed: { count: 0, total },
        resume: student ? (resumeByClass.get(c.classId) ?? null) : null,
        studentCount: student ? null : (studentCounts.get(c.classId) ?? 0),
      };
    }),
    courses: courseRows.map((c) => ({
      ...c,
      topicCount: draftTopics.get(c.courseId) ?? 0,
      classCount: classTotals.get(c.courseId) ?? 0,
    })),
  };
}

interface Resume {
  topicId: string;
  topicTitle: string;
  tab: 'slides' | 'reading' | 'exercises' | 'notebooks' | 'tests';
  resourceTitle: string;
}

/** Whether the person already teaches: an instructor class membership or any course grant. */
export async function teachesAnything(db: Db, scope: UserScope): Promise<boolean> {
  const userId = scope.user.id;
  const [asInstructor] = await db
    .select({ id: classMemberships.id })
    .from(classMemberships)
    .where(
      and(
        eq(classMemberships.userId, userId),
        eq(classMemberships.role, 'instructor'),
        eq(classMemberships.isPreview, false),
      ),
    )
    .limit(1);
  if (asInstructor) return true;
  const [asCourseMember] = await db
    .select({ id: courseMemberships.id })
    .from(courseMemberships)
    .where(eq(courseMemberships.userId, userId))
    .limit(1);
  return asCourseMember !== undefined;
}

export async function createCourseFor(
  db: Db,
  scope: UserScope,
  title: string,
): Promise<{ id: string; title: string } | 'not_instructor'> {
  if (scope.user.kind !== 'user' || !(await teachesAnything(db, scope))) return 'not_instructor';
  const id = await createCourse(db, { title, ownerId: scope.user.id });
  return { id, title };
}
