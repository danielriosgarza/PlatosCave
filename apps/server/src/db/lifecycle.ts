import { randomUUID } from 'node:crypto';
import { strokesToSvg } from '@parallax/contracts';
import type * as contracts from '@parallax/contracts/routes/lifecycle';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgColumn } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { ClassManagerScope, ClassScope, CourseScope, UserScope } from '../auth/scope';
import { audit } from './audit';
import type { Db, Tx } from './client';
import { revokeUserConnectorsIn } from './connectors/registry';
import { otherActiveOwnerExists } from './courseOwners';
import {
  annotations,
  auditEvents,
  authSessions,
  classes,
  classInvites,
  connectorPairings,
  connectors,
  courseMemberships,
  courses,
  fileTransfers,
  notebookConnections,
  notebookSessions,
  notebookSubmissionFiles,
  notebookSubmissions,
  notebookWorkingCopies,
  notebookWorkingCopyRevisions,
  posts,
  resources,
  signinTokens,
  threads,
  topics,
  users,
} from './schema';
import { forClass } from './scoped';

/**
 * The data lifecycle (§4, §8, §12, §13): archive and restore, a person's own export, and closing
 * an account. Archiving only sets a timestamp; what an archived class or course refuses is
 * decided once, in `registerRoute`, from the resolved scope.
 */

type Exported = z.input<typeof contracts.exportAnnotations.response>;

/** What an archive or restore call leaves behind, or why it changed nothing. */
export type ArchiveOutcome =
  | { ok: true; id: string; archived: boolean }
  | { ok: false; reason: 'not_archived' | 'course_archived' | 'already_archived' };

/** Archives the scope's class. Nothing changes, and nothing is audited, if it already is. */
export function archiveClass(db: Db, scope: ClassManagerScope, now: Date): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(classes)
      .set({ archivedAt: now })
      .where(and(eq(classes.id, scope.classId), isNull(classes.archivedAt)))
      .returning({ id: classes.id });
    if (!row) return { ok: false, reason: 'already_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.archive',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      before: { archived: false },
      after: { archived: true, via: scope.via },
    });
    return { ok: true, id: row.id, archived: true };
  });
}

/** Restores the scope's class, unless its course is archived too: that is restored first. */
export function restoreClass(db: Db, scope: ClassManagerScope, now: Date): Promise<ArchiveOutcome> {
  if (scope.courseArchived) return Promise.resolve({ ok: false, reason: 'course_archived' });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(classes)
      .set({ archivedAt: null })
      .where(and(eq(classes.id, scope.classId), sql`${classes.archivedAt} is not null`))
      .returning({ id: classes.id });
    if (!row) return { ok: false, reason: 'not_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'class.restore',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'class',
      targetId: scope.classId,
      before: { archived: true },
      after: { archived: false, via: scope.via, at: now.toISOString() },
    });
    return { ok: true, id: row.id, archived: false };
  });
}

export function archiveCourse(db: Db, scope: CourseScope, now: Date): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(courses)
      .set({ archivedAt: now })
      .where(and(eq(courses.id, scope.courseId), isNull(courses.archivedAt)))
      .returning({ id: courses.id });
    if (!row) return { ok: false, reason: 'already_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'course.archive',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'course',
      targetId: scope.courseId,
      before: { archived: false },
      after: { archived: true },
    });
    return { ok: true, id: row.id, archived: true };
  });
}

export function restoreCourse(db: Db, scope: CourseScope): Promise<ArchiveOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(courses)
      .set({ archivedAt: null })
      .where(and(eq(courses.id, scope.courseId), sql`${courses.archivedAt} is not null`))
      .returning({ id: courses.id });
    if (!row) return { ok: false, reason: 'not_archived' };
    await audit(tx, {
      actorId: scope.user.id,
      action: 'course.restore',
      scopeKind: 'course',
      scopeId: scope.courseId,
      targetType: 'course',
      targetId: scope.courseId,
      before: { archived: true },
      after: { archived: false },
    });
    return { ok: true, id: row.id, archived: false };
  });
}

/** The default proportions of a figure and of a page, as the reading's own sketch export uses. */
const FIGURE_ASPECT = 0.6;
const PAGE_ASPECT = 1.414;

type AnchorOf = Exported['annotations'][number]['source']['anchor'];

/** A mark's place in words, and the passage it quotes, if any (§8). */
function describeAnchor(anchor: AnchorOf): { reference: string; quote: string | null } {
  switch (anchor.kind) {
    case 'text':
      return { reference: 'passage', quote: anchor.quote };
    case 'pdf':
      return { reference: `page ${anchor.page + 1}`, quote: anchor.quote ?? null };
    case 'slide':
      return { reference: `slide ${anchor.page + 1}`, quote: null };
    case 'figure':
      return { reference: `figure ${anchor.figureId}`, quote: null };
    case 'none':
      return { reference: 'whole resource', quote: null };
  }
}

/** A sketch's strokes as a standalone SVG, with its description as the accessible text. */
function drawingOf(
  anchor: AnchorOf,
  title: string,
  description: string | null,
): { svg: string; description: string | null } | null {
  if (anchor.kind !== 'figure' && anchor.kind !== 'pdf') return null;
  if (!anchor.strokes) return null;
  const svg = strokesToSvg(anchor.strokes, {
    aspect: anchor.kind === 'pdf' ? PAGE_ASPECT : FIGURE_ASPECT,
    title: `Sketch · ${title}`,
    description: description ?? '',
  });
  return { svg, description };
}

/**
 * The caller's own annotations in the scope's class, and their own posts (§8 "private annotation
 * export includes text, resource title, source reference, and readable drawings"). Only rows the
 * caller authored are read, and only this class's; the export is audited (§13).
 */
export function exportOwnAnnotations(db: Db, scope: ClassScope, now: Date): Promise<Exported> {
  return db.transaction(async (tx) => {
    const marks = await tx
      .select({
        annotation: annotations,
        resourceTitle: resources.title,
        topicTitle: topics.title,
      })
      .from(annotations)
      .innerJoin(resources, eq(resources.id, annotations.resourceId))
      .innerJoin(topics, eq(topics.id, resources.topicId))
      .where(and(forClass(scope, annotations), eq(annotations.authorId, scope.user.id)))
      .orderBy(asc(annotations.createdAt), asc(annotations.id));
    const written = await tx
      .select({
        id: posts.id,
        threadId: posts.threadId,
        body: posts.body,
        deletedAt: posts.deletedAt,
        moderatedAt: posts.moderatedAt,
        createdAt: posts.createdAt,
        audience: threads.audience,
        resourceTitle: resources.title,
      })
      .from(posts)
      .innerJoin(threads, and(eq(threads.id, posts.threadId), eq(threads.classId, posts.classId)))
      .innerJoin(resources, eq(resources.id, threads.resourceId))
      .where(and(forClass(scope, posts), eq(posts.authorId, scope.user.id)))
      .orderBy(asc(posts.createdAt), asc(posts.id));
    await audit(tx, {
      actorId: scope.user.id,
      action: 'export.annotations',
      scopeKind: 'class',
      scopeId: scope.classId,
      targetType: 'user',
      targetId: scope.user.id,
      after: { annotations: marks.length, posts: written.length },
    });
    return {
      exportedAt: now.toISOString(),
      class: { id: scope.classId, name: scope.className },
      course: { id: scope.courseId, title: scope.courseTitle },
      annotations: marks.map(({ annotation: a, resourceTitle, topicTitle }) => {
        const { reference, quote } = describeAnchor(a.anchor);
        return {
          id: a.id,
          kind: a.kind,
          body: a.body,
          resourceTitle,
          topicTitle,
          source: {
            resourceId: a.resourceId,
            resourceRevisionId: a.resourceRevisionId,
            anchor: a.anchor,
            reference,
            quote,
          },
          drawing: a.kind === 'sketch' ? drawingOf(a.anchor, resourceTitle, a.body) : null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        };
      }),
      posts: written.map((p) => ({
        id: p.id,
        threadId: p.threadId,
        audience: p.audience === 'class' ? ('class' as const) : ('instructor' as const),
        resourceTitle: p.resourceTitle,
        // Hidden the way the thread view hides it, from its author too.
        body: p.deletedAt || p.moderatedAt ? null : p.body,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  });
}

/**
 * What deleting an account does to each table that refers to a person (plan decision 23, §13,
 * P3-AUD10): `deleted`, every row of theirs goes; `pruned`, rows no submission needs go and the
 * rest keep no identifying detail; `redacted`, rows stay with identifying details replaced;
 * `kept`, records the organisation keeps, which show the pseudonym. `lifecycle.test.ts` fails
 * when a table referring to `users` is missing here, so a new one cannot be forgotten; only
 * `deleted` is checked generically (the lifecycle integration test), the other values record
 * what `anonymiseIdentity` does and are checked table by table where it does it.
 */
export const accountDeletion = {
  annotation_placements: 'kept',
  annotations: 'deleted',
  assignment_overrides: 'kept',
  assignments: 'kept',
  audit_events: 'redacted',
  auth_sessions: 'kept',
  class_compute_templates: 'kept',
  class_invites: 'redacted',
  class_memberships: 'kept',
  class_release_history: 'kept',
  connector_pairings: 'deleted',
  connectors: 'redacted',
  course_memberships: 'kept',
  course_releases: 'kept',
  courses: 'kept',
  execution_jobs: 'kept',
  execution_results: 'kept',
  exercise_attempts: 'kept',
  file_transfers: 'pruned',
  grade_overrides: 'kept',
  grade_releases: 'kept',
  grades: 'kept',
  notebook_connections: 'pruned',
  notebook_sessions: 'pruned',
  notebook_submissions: 'kept',
  notebook_working_copies: 'pruned',
  posts: 'kept',
  resource_revisions: 'kept',
  resources: 'kept',
  storage_objects: 'kept',
  study_positions: 'kept',
  test_attempts: 'kept',
  test_submissions: 'kept',
  threads: 'kept',
  topic_reviews: 'kept',
  topics: 'kept',
  users: 'redacted',
} as const satisfies Record<string, 'deleted' | 'pruned' | 'redacted' | 'kept'>;

export const ANONYMISED_NAME = 'Former user';
export const anonymisedEmail = (userId: string) => `deleted-${userId}@anonymised.invalid`;

/**
 * Replaces one identity with a pseudonym and deletes what was only theirs (plan decision 23):
 * the name and address, private annotations (their placements go with them), unused sign-in
 * links and unused instructor invitations addressed to the old address, unsubmitted working
 * copies, and their compute: connections, trusted host keys, connector names and sessions and
 * file transfers no submission refers to (P3-AUD10). Memberships, grades, submissions, posts and
 * audit rows stay and now carry the pseudonym. The caller records why.
 */
export async function anonymiseIdentity(tx: Tx, userId: string, now: Date): Promise<void> {
  const [row] = await tx
    .select({ email: users.email, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!row) return;
  const previews = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.ownerUserId, userId));
  const everyone = [userId, ...previews.map((p) => p.id)];
  await tx.delete(annotations).where(inArray(annotations.authorId, everyone));
  await deleteUnsubmittedWorkingCopies(tx, everyone);
  await deleteNotebookCompute(tx, everyone, now);
  if (row.email) {
    const pseudonym = anonymisedEmail(userId);
    await tx.delete(signinTokens).where(eq(signinTokens.email, row.email));
    // Unused invitations are deleted; a used one is a record of who joined, so it keeps its row
    // under the pseudonym, and so do the audit events that quoted the address.
    await tx
      .delete(classInvites)
      .where(
        and(
          eq(classInvites.email, row.email),
          eq(classInvites.kind, 'instructor'),
          eq(classInvites.useCount, 0),
        ),
      );
    await tx
      .update(classInvites)
      .set({ email: pseudonym })
      .where(eq(classInvites.email, row.email));
    const replaced = (column: AnyPgColumn) =>
      sql`jsonb_set(${column}, '{email}', to_jsonb(${pseudonym}::text))`;
    await tx
      .update(auditEvents)
      .set({ before: replaced(auditEvents.before) })
      .where(sql`${auditEvents.before} ->> 'email' = ${row.email}`);
    await tx
      .update(auditEvents)
      .set({ after: replaced(auditEvents.after) })
      .where(sql`${auditEvents.after} ->> 'email' = ${row.email}`);
  }
  await tx
    .update(users)
    .set({ name: ANONYMISED_NAME, anonymisedAt: now })
    .where(inArray(users.id, everyone));
  // A preview principal has no address; only the person's own row takes the pseudonymous one.
  if (row.kind === 'user') {
    await tx
      .update(users)
      .set({ email: anonymisedEmail(userId) })
      .where(eq(users.id, userId));
  }
}

/**
 * Deletes the people's working copies of notebooks that no submission froze, with their revisions
 * (the rows; stored objects are not removed here, and a key may be shared, so a later cleanup must
 * check references first). A copy a submission froze stays with only the revisions submissions
 * reference, and its current revision moves to the newest of them. Sessions that pointed at a
 * copy are unlinked first, because Connect ties every session to its copy.
 */
async function deleteUnsubmittedWorkingCopies(tx: Tx, userIds: string[]): Promise<void> {
  const copies = tx
    .select({ id: notebookWorkingCopies.id })
    .from(notebookWorkingCopies)
    .where(inArray(notebookWorkingCopies.userId, userIds));
  await tx
    .update(notebookSessions)
    .set({ workingCopyId: null })
    .where(inArray(notebookSessions.workingCopyId, copies));
  const frozen = (copyId: PgColumn) =>
    sql`exists (select 1 from ${notebookSubmissions} s where s.working_copy_id = ${copyId})`;
  await tx
    .delete(notebookWorkingCopies)
    .where(
      and(
        inArray(notebookWorkingCopies.userId, userIds),
        sql`not ${frozen(notebookWorkingCopies.id)}`,
      ),
    );
  // What is left was frozen by a submission: keep the revisions submissions reference.
  await tx.execute(sql`
    delete from ${notebookWorkingCopyRevisions} r
    using ${notebookWorkingCopies} c
    where r.working_copy_id = c.id and c.user_id in (${sql.join(
      userIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      and not exists (select 1 from ${notebookSubmissions} s
        where s.working_copy_id = r.working_copy_id and s.working_copy_revision = r.revision)`);
  await tx
    .update(notebookWorkingCopies)
    .set({
      currentRevision: sql`(select max(r.revision) from ${notebookWorkingCopyRevisions} r
        where r.working_copy_id = ${notebookWorkingCopies.id})`,
    })
    .where(inArray(notebookWorkingCopies.userId, userIds));
}

/** What a connector, connection or file transfer's audit events said that identified the person. */
const IDENTIFYING_AUDIT_KEYS: Record<string, string[]> = {
  connector: ['name', 'os'],
  connection: ['name', 'target', 'host', 'port', 'sha256'],
  file_transfer: ['path'],
};
const REDACTED_CONNECTOR_NAME = 'Removed connector';
const REDACTED_CONNECTION_NAME = 'Removed connection';
const REDACTED_TRANSFER_PATH = 'removed';

/**
 * Deletes the people's notebook compute (P3-AUD10, owner decision on #459): file transfers no
 * submission froze, sessions no submission refers to (their cell executions go with them), and
 * connections no remaining session needs. What a submission still refers to stays without what
 * identified the person's machines: a kept transfer loses its remote path and conflict detail, a
 * kept session the environment its connector reported, a kept connection its name, target
 * details, runtime and trusted host keys. Every connector of theirs keeps its row (its id is in
 * the audit trail) without its name, OS or network scope, and their audit events lose the same
 * details. Stored objects of deleted transfers are not removed here, as for working copies.
 */
async function deleteNotebookCompute(tx: Tx, userIds: string[], now: Date): Promise<void> {
  const connectorIds = (
    await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(inArray(connectors.ownerUserId, userIds))
  ).map((r) => r.id);
  const connectionIds = (
    await tx
      .select({ id: notebookConnections.id })
      .from(notebookConnections)
      .where(inArray(notebookConnections.ownerUserId, userIds))
  ).map((r) => r.id);
  const transferIds = (
    await tx
      .select({ id: fileTransfers.id })
      .from(fileTransfers)
      .where(inArray(fileTransfers.userId, userIds))
  ).map((r) => r.id);

  await tx.delete(fileTransfers).where(
    and(
      inArray(fileTransfers.userId, userIds),
      sql`not exists (select 1 from ${notebookSubmissionFiles} f
          where f.file_transfer_id = ${fileTransfers.id})`,
    ),
  );
  await tx
    .update(fileTransfers)
    .set({ path: REDACTED_TRANSFER_PATH, conflict: null })
    .where(inArray(fileTransfers.userId, userIds));
  await keepOnlyFileNames(tx, userIds);
  await tx.delete(notebookSessions).where(
    and(
      inArray(notebookSessions.userId, userIds),
      sql`not exists (select 1 from ${notebookSubmissions} s
          where s.session_id = ${notebookSessions.id})`,
      sql`not exists (select 1 from ${fileTransfers} t where t.session_id = ${notebookSessions.id})`,
    ),
  );
  await tx
    .update(notebookSessions)
    .set({ environment: null })
    .where(inArray(notebookSessions.userId, userIds));
  await tx.delete(notebookConnections).where(
    and(
      inArray(notebookConnections.ownerUserId, userIds),
      sql`not exists (select 1 from ${notebookSessions} s
          where s.connection_id = ${notebookConnections.id})`,
    ),
  );
  await tx
    .update(notebookConnections)
    .set({
      name: REDACTED_CONNECTION_NAME,
      target: sql`jsonb_build_object('kind', ${notebookConnections.target} -> 'kind')`,
      runtime: sql`jsonb_build_object('mode', ${notebookConnections.runtime} -> 'mode')`,
      trustedHostKeys: [],
      updatedAt: now,
      archivedAt: sql`coalesce(${notebookConnections.archivedAt}, ${now})`,
    })
    .where(inArray(notebookConnections.ownerUserId, userIds));
  await tx
    .update(connectors)
    .set({ name: REDACTED_CONNECTOR_NAME, os: '', networkScope: { cidrs: [], hosts: [] } })
    .where(inArray(connectors.ownerUserId, userIds));

  const targets: Record<string, string[]> = {
    connector: connectorIds,
    connection: connectionIds,
    file_transfer: transferIds,
  };
  for (const [targetType, keys] of Object.entries(IDENTIFYING_AUDIT_KEYS)) {
    const ids = targets[targetType] ?? [];
    if (ids.length === 0) continue;
    const dropped = sql`array[${sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `,
    )}]::text[]`;
    await tx
      .update(auditEvents)
      .set({
        before: sql`${auditEvents.before} - ${dropped}`,
        after: sql`${auditEvents.after} - ${dropped}`,
      })
      .where(and(eq(auditEvents.targetType, targetType), inArray(auditEvents.targetId, ids)));
  }
}

/**
 * A submission froze each file under its workspace path; what stays of a deleted person's
 * submissions names each file by its last segment only, numbered where two would share a name
 * (the key is submission and path). Every row moves to a temporary name first, so no rename can
 * meet a name another row is about to leave.
 */
async function keepOnlyFileNames(tx: Tx, userIds: string[]): Promise<void> {
  const rows = await tx
    .select({
      submissionId: notebookSubmissionFiles.submissionId,
      path: notebookSubmissionFiles.path,
    })
    .from(notebookSubmissionFiles)
    .innerJoin(
      notebookSubmissions,
      eq(notebookSubmissions.id, notebookSubmissionFiles.submissionId),
    )
    .where(inArray(notebookSubmissions.userId, userIds))
    .orderBy(asc(notebookSubmissionFiles.submissionId), asc(notebookSubmissionFiles.path));
  if (rows.length === 0) return;
  const taken = new Map<string, Set<string>>();
  const renames = rows.map((row) => {
    const names = taken.get(row.submissionId) ?? new Set<string>();
    taken.set(row.submissionId, names);
    const base = row.path.slice(row.path.lastIndexOf('/') + 1) || 'file';
    let name = base;
    for (let n = 2; names.has(name); n += 1) name = `${n}-${base}`;
    names.add(name);
    return { ...row, temporary: randomUUID(), name };
  });
  const at = (submissionId: string, path: string) =>
    and(
      eq(notebookSubmissionFiles.submissionId, submissionId),
      eq(notebookSubmissionFiles.path, path),
    );
  for (const r of renames)
    await tx
      .update(notebookSubmissionFiles)
      .set({ path: r.temporary })
      .where(at(r.submissionId, r.path));
  for (const r of renames)
    await tx
      .update(notebookSubmissionFiles)
      .set({ path: r.name })
      .where(at(r.submissionId, r.temporary));
}

export type CloseOutcome =
  | { ok: true; deactivatedAt: Date; revokedConnectorIds: string[] }
  | { ok: false; reason: 'owns_courses' };

/**
 * Closes the caller's own account (§13): refused while they are the only active owner of a course; otherwise the
 * account and its preview principal are deactivated, every session ends, and with `delete` the
 * identity is anonymised, and their connectors are revoked, in the same transaction. The caller
 * then closes the live links of the revoked connectors.
 */
export function closeAccount(
  db: Db,
  scope: UserScope,
  mode: 'deactivate' | 'delete',
  now: Date,
): Promise<CloseOutcome> {
  const userId = scope.user.id;
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    // Co-owners closing at once must not each see the other as still active: lock every owner
    // membership of the caller's courses, in id order, so the second waits for the first.
    await tx.execute(sql`
      select o.id from course_memberships o
      where o.owner and o.course_id in
        (select m.course_id from course_memberships m where m.user_id = ${userId} and m.owner)
      order by o.id for update`);
    // A course whose only active owner leaves could never be managed or restored (§3).
    const soleOwned = await tx
      .select({ courseId: courseMemberships.courseId })
      .from(courseMemberships)
      .where(
        and(
          eq(courseMemberships.userId, userId),
          eq(courseMemberships.owner, true),
          sql`not ${otherActiveOwnerExists(courseMemberships.courseId, userId)}`,
        ),
      )
      .limit(1);
    if (soleOwned.length > 0) return { ok: false, reason: 'owns_courses' };
    const previews = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.ownerUserId, userId));
    const userIds = [userId, ...previews.map((p) => p.id)];
    await tx
      .update(users)
      .set({ deactivatedAt: now })
      .where(and(inArray(users.id, userIds), isNull(users.deactivatedAt)));
    await tx
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(inArray(authSessions.userId, userIds), isNull(authSessions.revokedAt)));
    // A pairing code issued before the account closed could otherwise still start a pairing.
    await tx.delete(connectorPairings).where(inArray(connectorPairings.ownerUserId, userIds));
    await audit(tx, {
      actorId: userId,
      action: mode === 'delete' ? 'account.delete' : 'account.deactivate',
      scopeKind: 'user',
      scopeId: userId,
      targetType: 'user',
      targetId: userId,
      after: { deactivated: true, anonymised: mode === 'delete' },
    });
    // In the same transaction, so a failure cannot leave connectors live on a closed account.
    const revokedConnectorIds: string[] = [];
    for (const id of userIds)
      revokedConnectorIds.push(...(await revokeUserConnectorsIn(tx, id, now)));
    // After revocation, which records the sessions it can no longer confirm, before they go.
    if (mode === 'delete') await anonymiseIdentity(tx, userId, now);
    return { ok: true, deactivatedAt: now, revokedConnectorIds };
  });
}

/** What the retention job applied in one run. */
export interface RetentionResult {
  anonymised: number;
  auditEventsDeleted: number;
}

/**
 * Applies the retention policy (§13) as a system action: accounts deactivated for longer than
 * the grace period are anonymised, and audit events older than their retention period are
 * deleted. A rule whose period is null is off, so the default policy removes nothing.
 */
export async function applyRetention(
  db: Db,
  policy: { deactivatedGraceDays: number | null; auditEventDays: number | null },
  now: Date,
): Promise<RetentionResult> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  let anonymised = 0;
  if (policy.deactivatedGraceDays !== null) {
    const due = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.kind, 'user'),
          isNull(users.anonymisedAt),
          lt(users.deactivatedAt, daysAgo(policy.deactivatedGraceDays)),
        ),
      );
    for (const { id } of due) {
      await db.transaction(async (tx) => {
        await anonymiseIdentity(tx, id, now);
        await audit(tx, {
          actorId: null,
          action: 'account.anonymise',
          scopeKind: 'system',
          targetType: 'user',
          targetId: id,
          after: { reason: 'retention', graceDays: policy.deactivatedGraceDays },
        });
      });
      anonymised += 1;
    }
  }
  let auditEventsDeleted = 0;
  if (policy.auditEventDays !== null) {
    const gone = await db
      .delete(auditEvents)
      .where(lt(auditEvents.createdAt, daysAgo(policy.auditEventDays)))
      .returning({ id: auditEvents.id });
    auditEventsDeleted = gone.length;
  }
  return { anonymised, auditEventsDeleted };
}
