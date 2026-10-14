import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type CourseScope, resolveActorScope } from '../../auth/scope';
import { folderCourseId } from '../../content/folder-ids';
import type { SyncState } from '../../content/folder-plan';
import type { Db } from '../client';
import { createCourse } from '../identity';
import { courses, resourceRevisions, users } from '../schema';
import { forCourse } from '../scoped';
import { uniqueViolation } from '../unique';
import { listDrafts } from './drafts';

/**
 * The queries of `parallax sync` (docs/design/course-folder.md §10): its owner, its course and the
 * drafts it plans against. Course data is read through `forCourse` with the owner's scope from
 * `resolveActorScope`; `users` and `courses` are not scoped tables. No audit event is written
 * here: `createCourse` writes `course.create`, which names the owning account.
 */

/** The account that owns an instructor folder: the address of its `instructor.yaml`. */
export type FolderOwner = { id: string; email: string };

/** Step 1: the active account (kind `user`, not deactivated) with the address; never creates one. */
export async function findFolderOwner(db: Db, email: string): Promise<FolderOwner | null> {
  const active = and(eq(users.kind, 'user'), isNull(users.deactivatedAt));
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.email, email.toLowerCase()), active));
  return row?.email ? { id: row.id, email: row.email } : null;
}

/** The course the owner's folder of this name made (§4.2); null while it is not synced. */
export async function findSyncedCourse(db: Db, ownerId: string, folderName: string) {
  const id = folderCourseId(ownerId, folderName);
  const [row] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, id));
  return row?.id ?? null;
}

export type FolderCourse =
  | { ok: true; scope: CourseScope; created: boolean }
  | { ok: false; reason: 'not_instructor' | 'not_owner' | 'archived' };

/**
 * Step 2: the owner's `CourseScope` on the folder's course. A missing course is created with the
 * title of `course.yaml` only when the owner's address is on the allow-list (the first half of
 * `mayCreateCourse`); an existing one keeps its title. A course the account no longer owns, and
 * an archived one, are refused, and nothing is written for them.
 */
export async function ensureFolderCourse(
  db: Db,
  owner: FolderOwner,
  folderName: string,
  title: string,
  instructorEmails: readonly string[],
): Promise<FolderCourse> {
  const id = folderCourseId(owner.id, folderName);
  let created = false;
  if (!(await findSyncedCourse(db, owner.id, folderName))) {
    if (!instructorEmails.includes(owner.email)) return { ok: false, reason: 'not_instructor' };
    // A sync that made the course meanwhile leaves this one to find it.
    created = await createCourse(db, { id, title, ownerId: owner.id }).then(
      () => true,
      (err) => (uniqueViolation(err, 'courses_pkey') ? false : Promise.reject(err)),
    );
  }
  const resolved = await resolveActorScope(db, owner.id, { kind: 'course', role: 'owner' }, id);
  if (!resolved.ok) return { ok: false, reason: 'not_owner' };
  const scope = resolved.scope as CourseScope;
  return scope.archived ? { ok: false, reason: 'archived' } : { ok: true, scope, created };
}

/** Step 4's input: every draft of the course, archived ones included, each resource's head. */
export async function loadSyncState(
  db: Db,
  scope: CourseScope,
  folder: string,
): Promise<SyncState> {
  const drafts = (await listDrafts(db, scope)).topics;
  // The heads the drafts name, read after them: a revision never changes, so a save in between
  // cannot pair a draft with a head other than its own.
  const headIds = drafts.flatMap((t) => t.resources.flatMap((r) => r.headRevisionId ?? []));
  const heads = await db
    .select({
      id: resourceRevisions.id,
      content: resourceRevisions.content,
      objectKeys: resourceRevisions.objectKeys,
      accessibleAlternative: resourceRevisions.accessibleAlternative,
      provenance: resourceRevisions.provenance,
    })
    .from(resourceRevisions)
    .where(and(forCourse(scope, resourceRevisions), inArray(resourceRevisions.id, headIds)));
  const headOf = new Map(heads.map(({ id, ...head }) => [id, head]));
  return {
    courseId: scope.courseId,
    folder,
    topics: drafts.map(({ courseId: _c, updatedAt: _u, resources: _r, ...topic }) => topic),
    resources: drafts.flatMap((topic) =>
      topic.resources.map(
        ({ courseId: _c, releaseAt: _r, headRevisionId, updatedAt: _u, ...r }) => ({
          ...r,
          head: (headRevisionId && headOf.get(headRevisionId)) || null,
        }),
      ),
    ),
  };
}
