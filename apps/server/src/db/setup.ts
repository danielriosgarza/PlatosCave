import { courseFolder, type SiteSetup } from '@parallax/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  type ClassContext,
  type ClassManagerScope,
  type ClassScope,
  type CourseScope,
  resolveActorScope,
} from '../auth/scope';
import { audit } from './audit';
import type { Db, Executor, Tx } from './client';
import { adoptRelease } from './content/adoption';
import { findFolderOwner, findSyncedCourse } from './content/sync';
import { createClass } from './identity';
import { issueInvite } from './invites';
import { listMembers } from './members';
import { setClassOpen } from './openClass';
import { classes, classMemberships, courseMemberships, courseReleases, courses } from './schema';
import { forClass, forCourse } from './scoped';

/**
 * `parallax apply` (docs/design/site.md §8): the accounts first, then each class in one
 * transaction, through the existing data-access functions under scopes from `resolveActorScope`
 * for the owner of the class's course; their own transactions are savepoints in it. No stored
 * state and no account is created: a class is found by course and name, access by an open
 * enrolment invitation, instructors by membership, adoption by the class's release.
 */

/** Ends a class's transaction with nothing written; the message is the cause. */
class Refused extends Error {}

const NO_ACCOUNT = 'no active account has this address; that person signs in once first';
const PENDING = 'pending: the course is not synced; run parallax sync';
const REASONS: Record<string, string> = {
  class_archived: 'the class is archived',
  manual_grading: 'its release has test parts graded by hand, which an open class never takes',
  release_conflict: 'the class changed meanwhile; run apply again',
};
function refuse(reason: string): never {
  throw new Refused(REASONS[reason] ?? reason);
}

/** The course's classes of this name, archived ones included, oldest first. */
export const findClassByName = (ex: Executor, scope: CourseScope, name: string) =>
  ex
    .select({ id: classes.id })
    .from(classes)
    .where(and(forCourse(scope, classes), eq(classes.name, name)))
    .orderBy(asc(classes.createdAt), asc(classes.id));

/** The course's newest release; null while it has none. */
export async function latestRelease(ex: Executor, scope: CourseScope) {
  const [row] = await ex
    .select({ id: courseReleases.id, version: courseReleases.version })
    .from(courseReleases)
    .where(forCourse(scope, courseReleases))
    .orderBy(desc(courseReleases.version))
    .limit(1);
  return row ?? null;
}

/**
 * Class instructor membership and course draft editing, as an accepted instructor invitation
 * gives them (`acceptInstructorInvite`), recorded as `membership.add` by the scope's manager. An
 * instructor of the class is left as it is, and a student of it is refused, as an invitation
 * refuses one.
 */
export async function ensureInstructor(tx: Tx, scope: ClassManagerScope, userId: string) {
  const [member] = await tx
    .select({ role: classMemberships.role })
    .from(classMemberships)
    .where(and(forClass(scope, classMemberships), eq(classMemberships.userId, userId)));
  if (member) return member.role === 'instructor' ? 'member' : 'student';
  // Locked before the class membership exists, as `acceptInstructorInvite` locks it.
  const own = and(forCourse(scope, courseMemberships), eq(courseMemberships.userId, userId));
  await tx.select({ id: courseMemberships.id }).from(courseMemberships).where(own).for('update');
  await tx.insert(classMemberships).values({ classId: scope.classId, userId, role: 'instructor' });
  await tx
    .insert(courseMemberships)
    .values({ courseId: scope.courseId, userId, editor: true })
    .onConflictDoUpdate({
      target: [courseMemberships.courseId, courseMemberships.userId],
      set: { editor: true },
    });
  await audit(tx, {
    actorId: scope.user.id,
    action: 'membership.add',
    scopeKind: 'class',
    scopeId: scope.classId,
    targetType: 'user',
    targetId: userId,
    after: { role: 'instructor', courseEditor: true, via: scope.via },
  });
  return 'added';
}

/** Setup's own event for a class it changed: no actor, the account it acted for, the changes. */
export const recordSetup = (tx: Tx, scope: ClassContext, actingFor: string, changes: string[]) =>
  audit(tx, {
    actorId: null,
    action: 'setup.apply',
    scopeKind: 'class',
    scopeId: scope.classId,
    targetType: 'class',
    targetId: scope.classId,
    after: { actingFor, changes },
  });

type Instructor = { id: string; path: string };
type Class = SiteSetup['classes'][number];
type Rule = Parameters<typeof resolveActorScope>[2];

/** A scope from `resolveActorScope` on the class's transaction, which sees its earlier writes. */
async function scopeOn<S>(tx: Db, actorId: string, rule: Rule, id: string) {
  const resolved = await resolveActorScope(tx, actorId, rule, id);
  if (!resolved.ok) throw new Error(`setup: ${resolved.reason}`);
  return resolved.scope as S;
}

/** One class: what it changed, joined for the report, or `unchanged`. */
async function applyClass(db: Db, cls: Class, people: Map<string, Instructor>, origin: string) {
  const at = (r: string) => people.get(r) as Instructor;
  const { owner, folder } = courseFolder(cls.course);
  const ownerId = at(owner).id;
  const courseId = await findSyncedCourse(db, ownerId, folder);
  if (!courseId) return PENDING;
  const rule = { kind: 'course', role: 'owner' } as const;
  const resolved = await resolveActorScope(db, ownerId, rule, courseId);
  if (!resolved.ok) refuse(`${at(owner).path}: the account does not own this course`);
  const course = resolved.scope as CourseScope;
  if (course.archived) refuse('the course is archived');
  // A first sync that stopped before publishing leaves a course with no release.
  const release = await latestRelease(db, course);
  if (!release) return PENDING;

  return db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    // One run at a time per course, so two cannot both create the class or a code.
    const lock = eq(courses.id, courseId);
    await tx.select({ id: courses.id }).from(courses).where(lock).for('no key update');
    const found = await findClassByName(tx, course, cls.name);
    const ids = found.map((row) => row.id).join(', ');
    if (found.length > 1) refuse(`two or more classes of the course have this name: ${ids}`);
    const changes: string[] = [];
    const said: string[] = [];
    const note = (change: string, words: string) => {
      changes.push(change);
      said.push(words);
    };
    const classId = found[0]?.id ?? (await createClass(handle, course, { name: cls.name })).id;
    if (!found[0]) note('class.create', 'class created');
    const managing = { kind: 'class', role: 'any', grant: 'manage_members' } as const;
    const manager = await scopeOn<ClassManagerScope>(handle, ownerId, managing, classId);
    if (manager.archived) refuse('class_archived');

    const added: string[] = [];
    for (const r of cls.instructors) {
      const outcome = await ensureInstructor(tx, manager, at(r).id);
      if (outcome === 'student') refuse(`${at(r).path}: the account is a student of this class`);
      if (outcome !== 'added') continue;
      changes.push('membership.add');
      added.push(r);
    }
    if (added.length > 0) said.push(`instructors ${added.join(', ')}`);
    // Adopted before the class opens: an open class refuses a release graded by hand.
    if (!manager.releaseId) {
      const first = at(cls.instructors[0] as string).id;
      const teaching = { kind: 'class', role: 'instructor' } as const;
      const teacher = await scopeOn<ClassScope>(handle, first, teaching, classId);
      const input = { releaseId: release.id, expectedReleaseId: null };
      const adopted = await adoptRelease(handle, teacher, input);
      if (!adopted.ok) refuse(adopted.reason);
      note('release.adopt', `release ${release.version} adopted`);
    }
    if (manager.open !== cls.open) {
      const set = await setClassOpen(handle, manager, cls.open);
      if (!set.ok) refuse(set.reason);
      note('class.open', cls.open ? 'opened' : 'closed');
    }
    // A link opens the class to anyone, so only a code with no limit and no expiry serves it.
    const now = new Date();
    const { invites } = await listMembers(handle, manager, now);
    const unlimited = (i: (typeof invites)[number]) => !i.maxUses && !i.expiresAt;
    if (!invites.some((i) => i.kind === 'enrolment' && (!cls.open || unlimited(i)))) {
      const issued = await issueInvite(handle, manager, { kind: 'enrolment' }, now);
      if (!issued.ok) refuse(issued.reason);
      const { code } = issued.invite;
      note(
        'invite.create',
        cls.open ? `join link ${origin}/join/${code}` : `enrolment code ${code}`,
      );
    }
    if (changes.length === 0) return 'unchanged';
    await recordSetup(tx, manager, ownerId, changes);
    return said.join('; ');
  });
}

/**
 * Hands `print` one line for each class as it is done, so a code already issued is shown even if
 * a later class fails. 1 when an account is missing (then nothing is written) or a class is
 * pending or refused; the other classes still run.
 */
export async function applySetup(db: Db, doc: SiteSetup, print: (line: string) => void) {
  const people = new Map<string, Instructor>();
  const missing: string[] = [];
  for (const { ref, path, email } of doc.instructors) {
    const account = await findFolderOwner(db, email);
    if (account) people.set(ref, { id: account.id, path });
    else missing.push(`${path}: ${NO_ACCOUNT}`);
  }
  missing.forEach(print);
  if (missing.length > 0) return 1 as const;
  let code: 0 | 1 = 0;
  for (const cls of doc.classes) {
    let line: string;
    try {
      line = await applyClass(db, cls, people, doc.appOrigin);
      if (line === PENDING) code = 1;
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      [line, code] = [`refused: ${err.message}`, 1];
    }
    print(`${cls.course}, ${cls.name}: ${line}`);
  }
  return code;
}
