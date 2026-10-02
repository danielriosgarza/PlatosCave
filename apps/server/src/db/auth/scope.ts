import { and, eq } from 'drizzle-orm';
import type { Actor } from '../../auth/sessions';
import type { Db } from '../client';
import { classes, classMemberships, courseMemberships, courses, users } from '../schema';
import { actorColumns } from './sessions';

// The reads behind scope resolution (`auth/scope.ts`, ADR-0002). They take raw ids because they
// run before any scope exists, and only `auth/scope.ts` calls them: routes and jobs go through
// `resolveScope` / `resolveActorScope`, which decide what each row allows.

/** One class with its course and the grants the resolver checks. */
export interface ClassAccess {
  className: string;
  courseId: string;
  courseTitle: string;
  releaseId: string | null;
  archivedAt: Date | null;
  /** The user's class membership; null when they hold none. */
  id: string | null;
  role: (typeof classMemberships.$inferSelect)['role'] | null;
  manageMembers: boolean | null;
  isPreview: boolean | null;
  /** Course grants of `courseUserId`; null when they hold none. */
  ownsCourse: boolean | null;
  editsCourse: boolean | null;
}

/** The user's membership and grants in one course. */
export interface CourseAccess {
  courseTitle: string;
  id: string;
  owner: boolean;
  editor: boolean;
  publisher: boolean;
}

/**
 * The actor with this id, for a background job acting without a session; null when there is
 * none. Takes a raw id: only `auth/scope.ts` calls it.
 */
export async function findActor(db: Db, actorId: string): Promise<Actor | null> {
  const [user] = await db.select(actorColumns).from(users).where(eq(users.id, actorId));
  return user ?? null;
}

/**
 * One class with its course, the user's class membership in it, and the course grants of
 * `courseUserId` (the user, or a preview principal's owner); null when no such class exists.
 * Takes raw ids: only `auth/scope.ts` calls it.
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
 * The user's membership and grants in one course; null when they hold none. Takes raw ids: only
 * `auth/scope.ts` calls it.
 */
export async function findCourseAccess(
  db: Db,
  userId: string,
  courseId: string,
): Promise<CourseAccess | null> {
  const [row] = await db
    .select({
      courseTitle: courses.title,
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
