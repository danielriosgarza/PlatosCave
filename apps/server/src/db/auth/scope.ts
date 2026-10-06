import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { classes, classMemberships, courseMemberships, courses, users } from '../schema';
import { type Actor, actorColumns } from './sessions';

// The reads behind scope resolution (`auth/scope.ts`, ADR-0002). They take raw ids because they
// run before any scope exists. Only `auth/scope.ts` imports this module (a lint probe holds it
// to that): routes and jobs go through `resolveScope` / `resolveActorScope`, which decide what
// each row allows.

type ClassRow = typeof classes.$inferSelect;
type CourseRow = typeof courses.$inferSelect;
type ClassMembershipRow = typeof classMemberships.$inferSelect;
type CourseMembershipRow = typeof courseMemberships.$inferSelect;
/** The columns of a left-joined table: all null when the join found no row. */
type Nullable<T> = { [K in keyof T]: T[K] | null };

/**
 * One class with its course and the grants the resolver checks. `id` onward are the user's class
 * membership (null when they hold none) and the course grants of `courseUserId` (`ownsCourse`,
 * `editsCourse`; null when they hold none).
 */
export type ClassAccess = Pick<ClassRow, 'courseId' | 'releaseId' | 'archivedAt'> & {
  className: ClassRow['name'];
  courseTitle: CourseRow['title'];
  courseArchivedAt: CourseRow['archivedAt'];
} & Nullable<Pick<ClassMembershipRow, 'id' | 'role' | 'manageMembers' | 'isPreview'>> & {
    ownsCourse: CourseMembershipRow['owner'] | null;
    editsCourse: CourseMembershipRow['editor'] | null;
  };

/** The user's membership and grants in one course. */
export type CourseAccess = Pick<CourseMembershipRow, 'id' | 'owner' | 'editor' | 'publisher'> & {
  courseTitle: CourseRow['title'];
  courseArchivedAt: CourseRow['archivedAt'];
};

/**
 * The actor with this id, for a background job acting without a session; null when there is none.
 */
export async function findActor(db: Db, actorId: string): Promise<Actor | null> {
  const [user] = await db
    .select(actorColumns)
    .from(users)
    .where(and(eq(users.id, actorId), isNull(users.deactivatedAt)));
  return user ?? null;
}

/**
 * One class with its course, the user's class membership in it, and the course grants of
 * `courseUserId` (the user, or a preview principal's owner); null when no such class exists.
 */
export async function findClassAccess(
  db: Db,
  userId: string,
  classId: string,
  courseUserId: string = userId,
): Promise<ClassAccess | null> {
  const [row] = await db
    .select({
      className: classes.name,
      courseId: classes.courseId,
      courseTitle: courses.title,
      courseArchivedAt: courses.archivedAt,
      releaseId: classes.releaseId,
      archivedAt: classes.archivedAt,
      id: classMemberships.id,
      role: classMemberships.role,
      manageMembers: classMemberships.manageMembers,
      isPreview: classMemberships.isPreview,
      ownsCourse: courseMemberships.owner,
      editsCourse: courseMemberships.editor,
    })
    .from(classes)
    .innerJoin(courses, eq(courses.id, classes.courseId))
    .leftJoin(
      classMemberships,
      and(eq(classMemberships.classId, classes.id), eq(classMemberships.userId, userId)),
    )
    .leftJoin(
      courseMemberships,
      and(
        eq(courseMemberships.courseId, classes.courseId),
        eq(courseMemberships.userId, courseUserId),
      ),
    )
    .where(eq(classes.id, classId));
  return row ?? null;
}

/**
 * The user's membership and grants in one course; null when there is no such course or the user
 * holds no membership in it.
 */
export async function findCourseAccess(
  db: Db,
  userId: string,
  courseId: string,
): Promise<CourseAccess | null> {
  const [row] = await db
    .select({
      courseTitle: courses.title,
      courseArchivedAt: courses.archivedAt,
      id: courseMemberships.id,
      owner: courseMemberships.owner,
      editor: courseMemberships.editor,
      publisher: courseMemberships.publisher,
    })
    .from(courses)
    .innerJoin(
      courseMemberships,
      and(eq(courseMemberships.courseId, courses.id), eq(courseMemberships.userId, userId)),
    )
    .where(eq(courses.id, courseId));
  return row ?? null;
}
