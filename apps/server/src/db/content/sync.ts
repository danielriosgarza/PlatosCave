import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { type CourseScope, resolveActorScope } from '../../auth/scope';
import { canonical } from '../../content/canonical';
import { folderCourseId } from '../../content/folder-ids';
import type { SyncState } from '../../content/folder-plan';
import { createDb, type Db, type Executor } from '../client';
import { createCourse } from '../identity';
import { type CreateBossOptions, createBoss } from '../jobs/boss';
import {
  courseReleases,
  courses,
  releaseResources,
  releaseTopics,
  resourceRevisions,
  resources,
  topics,
  users,
} from '../schema';
import { forCourse } from '../scoped';
import { uniqueViolation } from '../unique';
import { listDrafts } from './drafts';
import { publishRelease, type ValidateOptions, type ValidationReport } from './releases';

/**
 * The queries of `parallax sync` (docs/design/course-folder.md §10): its owner, its course, the
 * drafts it plans against, their fingerprint and the release it publishes. Course data is read
 * through `forCourse` with the owner's scope from `resolveActorScope`; `users` and `courses` are
 * not scoped tables. No audit event is written here: `createCourse` and `publishRelease` write
 * `course.create` and `release.publish`, which name the owning account.
 */

/** The account that owns an instructor folder: the address of its `instructor.yaml`. */
export type FolderOwner = { id: string; email: string };

/**
 * The handle and a queue in the API role (it sends and works no job) for one run of the sync
 * script, opened as `withDatabase` opens the handle and closed after `fn`. The caller creates
 * the queues it sends to, as the API does at startup.
 */
export async function withSyncDatabase<T>(
  url: string,
  handlers: Pick<CreateBossOptions, 'onError' | 'onWarning'>,
  fn: (db: Db, boss: PgBoss) => Promise<T>,
): Promise<T> {
  const { db, pool } = createDb(url, { onError: handlers.onError });
  const boss = createBoss(pool, { role: 'api', ...handlers });
  try {
    await boss.start();
    return await fn(db, boss);
  } finally {
    await boss.stop({ graceful: true });
    await pool.end();
  }
}

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

/** The columns a release copies from a draft topic, and from a draft resource. */
const topicColumns = (table: typeof topics | typeof releaseTopics) => ({
  position: table.position,
  title: table.title,
  objective: table.objective,
  prerequisites: table.prerequisites,
  completionRule: table.completionRule,
  estimatedMinutes: table.estimatedMinutes,
});
const resourceColumns = (table: typeof resources | typeof releaseResources) => ({
  position: table.position,
  title: table.title,
  visibility: table.visibility,
  releaseAt: table.releaseAt,
});

/**
 * Over what a release snapshots: each live topic's id and fields, and each live resource's id,
 * topic, fields and head revision. Drafts and a release give one value exactly when publishing
 * the drafts would snapshot that release again.
 */
function fingerprintOf(topicRows: object[], resourceRows: { releaseAt: Date | null }[]) {
  const items = resourceRows.map((r) => ({ ...r, releaseAt: r.releaseAt?.toISOString() ?? null }));
  const snapshot = canonical({ topics: topicRows, resources: items });
  return createHash('sha256').update(snapshot).digest('hex');
}

/**
 * The drafts' fingerprint; `lock` locks their rows until the caller's transaction ends. The lock
 * is `no key update`: it holds back every save of these rows, and lets through the key-share
 * locks of foreign keys (a resource moved into a locked topic), which would otherwise deadlock
 * with a save that holds its resource row.
 */
async function draftsPrint(db: Executor, scope: CourseScope, lock = false): Promise<string> {
  const topicQuery = db
    .select({ id: topics.id, ...topicColumns(topics) })
    .from(topics)
    .where(and(forCourse(scope, topics), isNull(topics.archivedAt)))
    .orderBy(asc(topics.id));
  const ofLiveTopic = and(eq(topics.id, resources.topicId), forCourse(scope, topics));
  const resourceQuery = db
    .select({
      id: resources.id,
      topicId: resources.topicId,
      revisionId: resources.headRevisionId,
      ...resourceColumns(resources),
    })
    .from(resources)
    .innerJoin(topics, and(ofLiveTopic, isNull(topics.archivedAt)))
    .where(and(forCourse(scope, resources), isNull(resources.archivedAt)))
    .orderBy(asc(resources.id));
  const topicRows = await (lock ? topicQuery.for('no key update') : topicQuery);
  const resourceRows = await (lock ? resourceQuery.for('no key update') : resourceQuery);
  return fingerprintOf(topicRows, resourceRows);
}

/** The newest release's fingerprint; null when the course has none. */
async function releasePrint(db: Executor, scope: CourseScope): Promise<string | null> {
  const [newest] = await db
    .select({ id: courseReleases.id })
    .from(courseReleases)
    .where(forCourse(scope, courseReleases))
    .orderBy(desc(courseReleases.version))
    .limit(1);
  if (!newest) return null;
  const topicRows = await db
    .select({ id: releaseTopics.topicId, ...topicColumns(releaseTopics) })
    .from(releaseTopics)
    .where(eq(releaseTopics.releaseId, newest.id))
    .orderBy(asc(releaseTopics.topicId));
  const resourceRows = await db
    .select({
      id: releaseResources.resourceId,
      topicId: releaseTopics.topicId,
      revisionId: releaseResources.resourceRevisionId,
      ...resourceColumns(releaseResources),
    })
    .from(releaseResources)
    .innerJoin(releaseTopics, eq(releaseTopics.id, releaseResources.releaseTopicId))
    .where(eq(releaseResources.releaseId, newest.id))
    .orderBy(asc(releaseResources.resourceId));
  return fingerprintOf(topicRows, resourceRows);
}

/** Step 6: the drafts' fingerprint once sync's writes are done. */
export const draftFingerprint = (db: Db, scope: CourseScope): Promise<string> =>
  draftsPrint(db, scope);

export type FolderRelease =
  | { status: 'published'; release: typeof courseReleases.$inferSelect; report: ValidationReport }
  | { status: 'blocked'; report: ValidationReport }
  | { status: 'unchanged' | 'conflict' };

/** Rolls back a release whose snapshot is not the drafts sync wrote. */
class SnapshotChanged extends Error {}

/**
 * Step 8, in one transaction under publication's lock on the course row. Drafts whose
 * fingerprint is not `fingerprint` (someone saved while sync waited) end as a conflict; drafts
 * equal to the newest release publish nothing; otherwise `publishRelease` runs in this
 * transaction with the server's settings, and a snapshot that differs from `fingerprint` (a row
 * added after the read) rolls its release back as the same conflict.
 */
export async function publishFolderRelease(
  db: Db,
  scope: CourseScope,
  fingerprint: string,
  opts: ValidateOptions,
): Promise<FolderRelease> {
  try {
    return await db.transaction(async (tx): Promise<FolderRelease> => {
      const course = eq(courses.id, scope.courseId);
      await tx.select({ id: courses.id }).from(courses).where(course).for('update');
      if ((await draftsPrint(tx, scope, true)) !== fingerprint) return { status: 'conflict' };
      if ((await releasePrint(tx, scope)) === fingerprint) return { status: 'unchanged' };
      // Typed for the handle; on a transaction its own transaction is a savepoint.
      const result = await publishRelease(tx as unknown as Db, scope, opts);
      if (!result.ok) return { status: 'blocked', report: result.report };
      if ((await releasePrint(tx, scope)) !== fingerprint) throw new SnapshotChanged();
      return { status: 'published', release: result.release, report: result.report };
    });
  } catch (err) {
    if (err instanceof SnapshotChanged) return { status: 'conflict' };
    throw err;
  }
}
