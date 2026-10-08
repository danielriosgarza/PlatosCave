import type { Scope } from '@parallax/contracts';
import type { FastifyRequest } from 'fastify';
import {
  findActor,
  findClassAccess,
  findCourseAccess,
  findStandInInstructor,
} from '../db/auth/scope';
import { type Actor, findPrincipal, type Principal } from '../db/auth/sessions';
import type { Db } from '../db/client';
import { readSessionToken } from './sessions';

/** §3: sensitive membership changes need an authentication no older than this. */
export const RECENT_AUTH_MS = 15 * 60_000;

/**
 * Type-only brand: no other module can name it, so scope objects can only come from the
 * resolver below, and data access taking a `ClassScope` cannot be handed a raw id (ADR-0002).
 */
declare const brand: unique symbol;

export interface ScopeBase {
  /** The person acting: a signed-in session, or the actor a background job runs for. */
  readonly user: Actor;
  /** Throws a 401 `recent_auth_required` error unless the session authenticated recently. */
  requireRecentAuth(): void;
}

/** Only routes resolve a user scope, so it always carries the session. */
export interface UserScope extends ScopeBase {
  readonly [brand]: 'user';
  readonly user: Principal;
}

/** What every class scope knows about its class; `forClass` accepts any of them. */
export interface ClassContext extends ScopeBase {
  readonly [brand]: 'class';
  readonly classId: string;
  readonly className: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly releaseId: string | null;
  /** The class is archived, or its course is: either way it keeps reads and refuses writes (§4). */
  readonly archived: boolean;
  /** Whether the course is the one archived, so restoring the class alone would not reopen it. */
  readonly courseArchived: boolean;
}

export interface ClassScope extends ClassContext {
  readonly membership: {
    id: string;
    role: 'student' | 'instructor';
    manageMembers: boolean;
    isPreview: boolean;
  };
  readonly role: 'student' | 'instructor';
  readonly grants: { manageMembers: boolean };
}

/**
 * Scope of `{ kind: 'class', grant: 'manage_members' }` routes. §3 lets the course owner manage
 * membership of every class of the course, so the caller need not be a class member; `via`
 * records which permission let them in.
 */
export interface ClassManagerScope extends ClassContext {
  readonly via: 'course_owner' | 'manage_members';
}

export interface CourseScope extends ScopeBase {
  readonly [brand]: 'course';
  readonly courseId: string;
  readonly courseTitle: string;
  readonly archived: boolean;
  readonly membership: { id: string; owner: boolean; editor: boolean; publisher: boolean };
  readonly grants: { owner: boolean; editor: boolean; publisher: boolean };
}

/**
 * A course scope, or the scope of a class manager (which knows its course), so course-side
 * effects of a membership change still go through a resolved scope (ADR-0002). A member's
 * `ClassScope` is not one: a student's class scope reaches no course rows.
 */
export type CourseContext = CourseScope | ClassManagerScope;

/**
 * The class scope of a preview principal. The resolver admits one only while its owner owns or
 * edits the course, so it may read the course draft it previews (ADR-0003).
 */
export interface DraftPreviewScope extends ClassScope {
  readonly membership: ClassScope['membership'] & { isPreview: true };
}

export const isDraftPreview = (scope: ClassScope): scope is DraftPreviewScope =>
  scope.membership.isPreview;

export type ScopeFor<S extends Scope> = S extends { kind: 'class'; grant: 'manage_members' }
  ? ClassManagerScope
  : S extends { kind: 'class' }
    ? ClassScope
    : S extends { kind: 'course' }
      ? CourseScope
      : S extends { kind: 'user' }
        ? UserScope
        : undefined;

export type Resolution =
  | { ok: true; scope: UserScope | ClassScope | ClassManagerScope | CourseScope | undefined }
  | { ok: false; status: 401 | 403 | 404 | 503; error: string; reason: string };

export interface ResolverDeps {
  db?: Db;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deny = (status: 401 | 403 | 404 | 503, reason: string): Resolution => {
  const error = { 401: 'unauthenticated', 403: 'forbidden', 404: 'not found', 503: 'unavailable' };
  return { ok: false, status, error: error[status], reason };
};

export function assertRecentAuth(authTime: Date, now: Date): void {
  if (now.getTime() - authTime.getTime() > RECENT_AUTH_MS) {
    throw Object.assign(new Error('Sign in again to change memberships'), {
      statusCode: 401,
      code: 'recent_auth_required',
    });
  }
}

/** Runs in each route's onRequest hook, before body parsing and validation (ADR-0002). */
export async function resolveScope(
  req: FastifyRequest,
  scope: Scope,
  deps: ResolverDeps,
): Promise<Resolution> {
  if (scope.kind === 'public') return { ok: true, scope: undefined };
  // No system token exists yet; system routes stay closed until one is designed.
  if (scope.kind === 'system') return deny(401, 'system scope has no authenticator yet');

  const token = readSessionToken(req);
  if (!token) return deny(401, 'no session cookie');
  const { db } = deps;
  if (!db) return deny(503, 'no database configured');
  const user = await findPrincipal(db, token, deps.now());
  if (!user) return deny(401, 'unknown, expired or revoked session');
  const base = {
    user,
    requireRecentAuth: () => assertRecentAuth(user.authTime, deps.now()),
  };

  if (scope.kind === 'user') return { ok: true, scope: base as unknown as UserScope };
  const params = (req.params ?? {}) as Record<string, string | undefined>;
  if (scope.kind === 'class') return resolveClass(db, base, scope, params.classId);
  return resolveCourse(db, base, scope, params.courseId);
}

type ClassRule = Extract<Scope, { kind: 'class' }>;
type CourseRule = Extract<Scope, { kind: 'course' }>;

/** What `requireRecentAuth()` throws on a scope resolved from an actor id. */
export class NoRecentAuthError extends Error {
  readonly statusCode = 401;
  readonly code = 'recent_auth_required';
}

/** Without a session, nothing can count as a recent sign-in (§3). */
const noRecentAuth = () => {
  throw new NoRecentAuthError('Background jobs cannot make sensitive changes');
};

/**
 * Resolves the class or course scope of a person acting without a session (a background job,
 * ADR-0002): loads the actor itself, so a scope comes only from a session token or an actor id.
 * Its `requireRecentAuth()` always throws `NoRecentAuthError`: no caller can make it permissive.
 */
export async function resolveActorScope(
  db: Db,
  actorId: string,
  rule: ClassRule | CourseRule,
  targetId: string,
): Promise<Resolution> {
  if (!UUID.test(actorId)) return deny(404, 'actor does not exist');
  const user = await findActor(db, actorId);
  if (!user) return deny(404, 'actor does not exist');
  const base = { user, requireRecentAuth: noRecentAuth };
  return rule.kind === 'class'
    ? resolveClass(db, base, rule, targetId)
    : resolveCourse(db, base, rule, targetId);
}

/**
 * The class scope of a stand-in for a job's actor (`ScopedJob.standIn`): the class's real
 * instructor who joined it first, resolved against the job's rule exactly as `resolveActorScope`
 * resolves any actor. Only for a class rule without a grant, whose role an instructor holds.
 */
export async function resolveStandInScope(
  db: Db,
  rule: ClassRule,
  classId: string,
): Promise<Resolution> {
  if (rule.grant !== undefined || rule.role === 'student') {
    return deny(403, 'no stand-in holds this rule');
  }
  if (!UUID.test(classId)) return deny(404, 'classId is not a uuid');
  const instructorId = await findStandInInstructor(db, classId);
  if (!instructorId) return deny(404, 'the class has no instructor');
  return resolveActorScope(db, instructorId, rule, classId);
}

/** A principal's membership in one class, checked against a route's or job's rule. */
async function resolveClass(
  db: Db,
  base: ScopeBase,
  scope: ClassRule,
  classId: string | undefined,
): Promise<Resolution> {
  const { user } = base;
  if (!classId || !UUID.test(classId)) return deny(404, 'classId is not a uuid');
  // A preview principal's course grants are its owner's: it studies the course draft (ADR-0003).
  const courseUser = user.kind === 'preview' && user.ownerUserId ? user.ownerUserId : user.id;
  const row = await findClassAccess(db, user.id, classId, courseUser);
  if (!row) return deny(404, 'no such class');
  const context = {
    ...base,
    classId,
    className: row.className,
    courseId: row.courseId,
    courseTitle: row.courseTitle,
    releaseId: row.releaseId,
    archived: row.archivedAt !== null || row.courseArchivedAt !== null,
    courseArchived: row.courseArchivedAt !== null,
  };
  // §3: the course owner manages membership of every class of the course, member or not.
  const owner = row.ownsCourse === true && user.kind === 'user';
  if (scope.grant === 'manage_members' && owner) {
    return { ok: true, scope: { ...context, via: 'course_owner' } as unknown as ClassManagerScope };
  }
  // A preview principal only ever acts through its preview membership, and vice versa.
  if (row.id === null || row.isPreview !== (user.kind === 'preview')) {
    return deny(404, 'not a member of this class');
  }
  // A draft preview lasts only while its owner may still edit the course draft it shows.
  if (user.kind === 'preview' && !row.ownsCourse && !row.editsCourse) {
    return deny(404, 'preview owner no longer edits this course');
  }
  if (scope.role !== 'any' && row.role !== scope.role) {
    return deny(403, `needs class role ${scope.role}`);
  }
  if (scope.grant === 'manage_members') {
    if (!row.manageMembers) return deny(403, 'needs grant manage_members');
    return {
      ok: true,
      scope: { ...context, via: 'manage_members' } as unknown as ClassManagerScope,
    };
  }
  const membership = {
    id: row.id,
    role: row.role as 'student' | 'instructor',
    manageMembers: row.manageMembers as boolean,
    isPreview: row.isPreview,
  };
  const resolved = {
    ...context,
    membership,
    role: membership.role,
    grants: { manageMembers: membership.manageMembers },
  };
  return { ok: true, scope: resolved as unknown as ClassScope };
}

/** A principal's grants on one course, checked against a route's or job's rule. */
async function resolveCourse(
  db: Db,
  base: ScopeBase,
  scope: CourseRule,
  courseId: string | undefined,
): Promise<Resolution> {
  const { user } = base;
  if (!courseId || !UUID.test(courseId)) return deny(404, 'courseId is not a uuid');
  const row = await findCourseAccess(db, user.id, courseId);
  if (!row || user.kind === 'preview') return deny(404, 'no membership in this course');
  const grants = { owner: row.owner, editor: row.editor, publisher: row.publisher };
  // Owners hold every course permission (§3: "New courses grant their creator these permissions").
  if (!grants.owner && !grants[scope.role]) return deny(403, `needs course grant ${scope.role}`);
  const resolved = {
    ...base,
    courseId,
    courseTitle: row.courseTitle,
    archived: row.courseArchivedAt !== null,
    membership: { id: row.id, ...grants },
    grants,
  };
  return { ok: true, scope: resolved as unknown as CourseScope };
}
