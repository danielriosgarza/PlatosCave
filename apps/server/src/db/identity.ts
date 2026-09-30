import { and, eq } from 'drizzle-orm';
import type { UserScope } from '../auth/scope';
import type { Db } from './client';
import {
  auditEvents,
  classes,
  classMemberships,
  courseMemberships,
  courses,
  users,
} from './schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Audit = typeof auditEvents.$inferInsert;

/** Actor of a membership change; null for system actions such as fixtures. */
type Actor = string | null;

const audit = (tx: Tx, event: Audit) => tx.insert(auditEvents).values(event);

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
  actor: Actor,
  input: { id?: string; courseId: string; name: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(classes).values(input).returning({ id: classes.id });
    if (!row) throw new Error('class insert returned no row');
    await audit(tx, {
      actorId: actor,
      action: 'class.create',
      scopeKind: 'course',
      scopeId: input.courseId,
      targetType: 'class',
      targetId: row.id,
      after: { name: input.name },
    });
    return row.id;
  });
}

/** A student membership: the only row an enrolment code can create (§3). */
export function addStudent(db: Db, actor: Actor, classId: string, userId: string) {
  return db.transaction(async (tx) => {
    await tx.insert(classMemberships).values({ classId, userId, role: 'student' });
    await audit(tx, {
      actorId: actor,
      action: 'membership.add',
      scopeKind: 'class',
      scopeId: classId,
      targetType: 'user',
      targetId: userId,
      after: { role: 'student' },
    });
  });
}

/**
 * A class instructor also gets draft editing on the class's course; publication and membership
 * management stay separate grants (§3, ADR-0002).
 */
export function addInstructor(db: Db, actor: Actor, classId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [cls] = await tx
      .select({ courseId: classes.courseId })
      .from(classes)
      .where(eq(classes.id, classId));
    if (!cls) throw new Error(`class ${classId} does not exist`);
    await tx.insert(classMemberships).values({ classId, userId, role: 'instructor' });
    await tx
      .insert(courseMemberships)
      .values({ courseId: cls.courseId, userId, editor: true })
      .onConflictDoUpdate({
        target: [courseMemberships.courseId, courseMemberships.userId],
        set: { editor: true },
      });
    await audit(tx, {
      actorId: actor,
      action: 'membership.add',
      scopeKind: 'class',
      scopeId: classId,
      targetType: 'user',
      targetId: userId,
      after: { role: 'instructor', courseEditor: true },
    });
  });
}

/**
 * The shadow principal an instructor uses for "Preview as student" in one class (ADR-0002):
 * a `preview` user owned by the instructor, holding an `is_preview` student membership.
 */
export function createPreviewPrincipal(
  db: Db,
  input: { id?: string; instructorId: string; classId: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [teaching] = await tx
      .select({ id: classMemberships.id })
      .from(classMemberships)
      .innerJoin(users, eq(users.id, classMemberships.userId))
      .where(
        and(
          eq(classMemberships.classId, input.classId),
          eq(classMemberships.userId, input.instructorId),
          eq(classMemberships.role, 'instructor'),
          eq(users.kind, 'user'),
        ),
      );
    if (!teaching) throw new Error('only an instructor of the class can have a preview principal');
    const [preview] = await tx
      .insert(users)
      .values({
        id: input.id,
        kind: 'preview',
        name: 'Preview student',
        ownerUserId: input.instructorId,
      })
      .returning({ id: users.id });
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
    return preview.id;
  });
}
