import { and, eq } from 'drizzle-orm';
import type { Actor } from '../../auth/sessions';
import type { Db } from '../client';
import { classes, classMemberships, courseMemberships, courses, users } from '../schema';
import { actorColumns } from './sessions';

// The reads behind scope resolution (`auth/scope.ts`, ADR-0002). They run before any scope
// exists, so they take ids; the resolver decides what each row allows.

/** The actor with this id, for a background job acting without a session. */
export async function findActor(db: Db, actorId: string): Promise<Actor | undefined> {
  const [user] = await db.select(actorColumns).from(users).where(eq(users.id, actorId));
  return user;
}

/**
 * One class with its course, the user's class membership in it, and the course grants of
 * `courseUserId` (the user, or a preview principal's owner); null when not held, undefined when
 * no such class exists.
 */
export async function findClassAccess(
  db: Db,
  userId: string,
  classId: string,
  courseUserId: string = userId,
) {
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
  return row;
}

/** The user's membership and grants in one course; undefined when they hold none. */
export async function findCourseAccess(db: Db, userId: string, courseId: string) {
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
  return row;
}
