import type { Scope } from '@parallax/contracts';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { classes, classMemberships, courseMemberships, courses } from '../db/schema';
import { findPrincipal, type Principal, readSessionToken } from './sessions';

/** §3: sensitive membership changes need an authentication no older than this. */
export const RECENT_AUTH_MS = 15 * 60_000;

/**
 * Type-only brand: no other module can name it, so scope objects can only come from the
 * resolver below, and data access taking a `ClassScope` cannot be handed a raw id (ADR-0002).
 */
declare const brand: unique symbol;

interface ScopeBase {
  readonly user: Principal;
  /** Throws a 401 `recent_auth_required` error unless the session authenticated recently. */
  requireRecentAuth(): void;
}

export interface UserScope extends ScopeBase {
  readonly [brand]: 'user';
}

/** What every class scope knows about its class; `forClass` accepts any of them. */
export interface ClassContext extends ScopeBase {
  readonly [brand]: 'class';
  readonly classId: string;
  readonly className: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly releaseId: string | null;
  readonly archived: boolean;
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
  readonly membership: { id: string; owner: boolean; editor: boolean; publisher: boolean };
  readonly grants: { owner: boolean; editor: boolean; publisher: boolean };
}

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
  const now = deps.now();
  const user = await findPrincipal(db, token, now);
  if (!user) return deny(401, 'unknown, expired or revoked session');
  const base = {
    user,
    requireRecentAuth: () => assertRecentAuth(user.authTime, deps.now()),
  };

  if (scope.kind === 'user') return { ok: true, scope: base as UserScope };

  const params = (req.params ?? {}) as Record<string, string | undefined>;
  if (scope.kind === 'class') {
    const classId = params.classId;
    if (!classId || !UUID.test(classId)) return deny(404, 'classId is not a uuid');
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
      })
      .from(classes)
      .innerJoin(courses, eq(courses.id, classes.courseId))
      .leftJoin(
        classMemberships,
        and(eq(classMemberships.classId, classes.id), eq(classMemberships.userId, user.id)),
      )
      .leftJoin(
        courseMemberships,
        and(
          eq(courseMemberships.courseId, classes.courseId),
          eq(courseMemberships.userId, user.id),
        ),
      )
      .where(eq(classes.id, classId));
    if (!row) return deny(404, 'no such class');
    const context = {
      ...base,
      classId,
      className: row.className,
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      releaseId: row.releaseId,
      archived: row.archivedAt !== null,
    };
    // §3: the course owner manages membership of every class of the course, member or not.
    const owner = row.ownsCourse === true && user.kind === 'user';
    if (scope.grant === 'manage_members' && owner) {
      return {
        ok: true,
        scope: { ...context, via: 'course_owner' } as unknown as ClassManagerScope,
      };
    }
    // A preview principal only ever acts through its preview membership, and vice versa.
    if (row.id === null || row.isPreview !== (user.kind === 'preview')) {
      return deny(404, 'not a member of this class');
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

  const courseId = params.courseId;
  if (!courseId || !UUID.test(courseId)) return deny(404, 'courseId is not a uuid');
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
      and(eq(courseMemberships.courseId, courses.id), eq(courseMemberships.userId, user.id)),
    )
    .where(eq(courses.id, courseId));
  if (!row || user.kind === 'preview') return deny(404, 'no membership in this course');
  const grants = { owner: row.owner, editor: row.editor, publisher: row.publisher };
  // Owners hold every course permission (§3: "New courses grant their creator these permissions").
  if (!grants.owner && !grants[scope.role]) return deny(403, `needs course grant ${scope.role}`);
  const resolved = {
    ...base,
    courseId,
    courseTitle: row.courseTitle,
    membership: { id: row.id, ...grants },
    grants,
  };
  return { ok: true, scope: resolved as unknown as CourseScope };
}
