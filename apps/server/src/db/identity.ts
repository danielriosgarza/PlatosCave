import { and, eq } from 'drizzle-orm';
import type { ClassScope, CourseScope, UserScope } from '../auth/scope';
import type { Db } from './client';
import {
  auditEvents,
  classes,
  classMemberships,
  courseMemberships,
  courses,
  users,
} from './schema';
import { forClass } from './scoped';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Audit = typeof auditEvents.$inferInsert;

/**
 * Appends audit events (ADR-0002) inside the transaction making the change; several in one
 * statement when given a non-empty array.
 */
export const audit = (tx: Tx, event: Audit | Audit[]) =>
  tx.insert(auditEvents).values(Array.isArray(event) ? event : [event]);

/** Every class and course context of the signed-in person (§3: contexts they can switch between). */
export async function listContexts(db: Db, scope: UserScope) {
  const userId = scope.user.id;
  const classRows = await db
    .select({
      classId: classes.id,
      className: classes.name,
      courseId: courses.id,
      courseTitle: courses.title,
      role: classMemberships.role,
      manageMembers: classMemberships.manageMembers,
      isPreview: classMemberships.isPreview,
    })
    .from(classMemberships)
    .innerJoin(classes, eq(classes.id, classMemberships.classId))
    .innerJoin(courses, eq(courses.id, classes.courseId))
    .where(eq(classMemberships.userId, userId))
    .orderBy(courses.title, classes.name);
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
  return { classes: classRows, courses: courseRows };
}

export async function createUser(
  db: Db,
  input: { id?: string; email: string; name: string },
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ ...input, email: input.email.toLowerCase() })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  return row.id;
}

/** Creating a course grants its creator the owner membership (ADR-0002). */
export function createCourse(
  db: Db,
  input: { id?: string; title: string; ownerId: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [course] = await tx
      .insert(courses)
      .values({ id: input.id, title: input.title, createdBy: input.ownerId })
      .returning({ id: courses.id });
    if (!course) throw new Error('course insert returned no row');
    const grants = { owner: true, editor: true, publisher: true };
    await tx
      .insert(courseMemberships)
      .values({ courseId: course.id, userId: input.ownerId, ...grants });
    await audit(tx, {
      actorId: input.ownerId,
      action: 'course.create',
      scopeKind: 'course',
      scopeId: course.id,
      targetType: 'user',
      targetId: input.ownerId,
      after: grants,
    });
    return course.id;
  });
}

export async function createClass(
  db: Db,
  scope: CourseScope,
  input: { id?: string; name: string },
): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(classes)
      .values({ id: input.id, courseId: scope.courseId, name: input.name })
      .returning({ id: classes.id, name: classes.name });
    if (!row) throw new Error('class insert returned no row');
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.create',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'class',
      targetId: row.id,
      after: { name: input.name },
    });
    return row;
  });
}

/**
 * The shadow principal an instructor uses for "Preview as student" in one class (ADR-0002):
 * a `preview` user owned by the instructor, holding an `is_preview` student membership.
 */
export function createPreviewPrincipal(
  db: Db,
  scope: ClassScope,
  input: { id?: string } = {},
): Promise<string> {
  const instructorId = scope.user.id;
  return db.transaction(async (tx) => {
    const [teaching] = await tx
      .select({ id: classMemberships.id })
      .from(classMemberships)
      .innerJoin(users, eq(users.id, classMemberships.userId))
      .where(
        and(
          forClass(scope, classMemberships),
          eq(classMemberships.userId, instructorId),
          eq(classMemberships.role, 'instructor'),
          eq(users.kind, 'user'),
        ),
      );
    if (!teaching) throw new Error('only an instructor of the class can have a preview principal');
    const preview = await insertPreviewPrincipal(tx, {
      classId: scope.classId,
      instructorId,
      id: input.id,
    });
    return preview.id;
  });
}

/**
 * Inserts the `preview` user owned by `instructorId` and its `is_preview` student membership
 * of `classId`, and audits it. Callers have checked that the instructor teaches the class.
 */
export async function insertPreviewPrincipal(
  tx: Tx,
  input: { classId: string; instructorId: string; id?: string },
): Promise<{ id: string; name: string }> {
  const [preview] = await tx
    .insert(users)
    .values({
      id: input.id,
      kind: 'preview',
      name: 'Preview student',
      ownerUserId: input.instructorId,
    })
    .returning({ id: users.id, name: users.name });
  if (!preview) throw new Error('preview user insert returned no row');
  await tx
    .insert(classMemberships)
    .values({ classId: input.classId, userId: preview.id, role: 'student', isPreview: true });
  await audit(tx, {
    actorId: input.instructorId,
    action: 'preview.create',
    scopeKind: 'class',
    scopeId: input.classId,
    targetType: 'user',
    targetId: preview.id,
  });
  return preview;
}
