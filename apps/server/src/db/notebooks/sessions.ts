import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { ClassScope } from '../../auth/scope';
import {
  isOpen,
  nextSessionState,
  OPEN_STATES,
  type SessionEvent,
  type SessionState,
} from '../../relay/session-state';
import { audit } from '../audit';
import type { Db, Executor, Tx } from '../client';
import type { OwnedConnection } from '../connectors/connections';
import { studyableRows } from '../content/releases';
import { notebookSessions, releaseResources, resourceRevisions } from '../schema';
import { forClass } from '../scoped';
import { uniqueViolation } from '../unique';

/**
 * Notebook sessions (docs/design/connector.md §2, §10.2, §10.7). A person reads and changes only
 * their own sessions through a resolved class scope: anyone else's, the class instructor's
 * included, reads as missing (A33). The relay changes a session only for the connector whose
 * authenticated link reported it, and every state change goes through `nextSessionState`.
 */

declare const ownedSession: unique symbol;

export type SessionRow = typeof notebookSessions.$inferSelect;

/** A session read through its owner's class scope (§10.4): the relay may message its connector. */
export type OwnedSession = SessionRow & { readonly [ownedSession]: true };

const own = (row: SessionRow) => row as OwnedSession;

/** Sessions of the caller in this class. */
const mine = (scope: ClassScope) =>
  and(forClass(scope, notebookSessions), eq(notebookSessions.userId, scope.user.id));

/** What a connector reported with a state: stored for display (§4.3 `session_state`). */
export interface SessionReport {
  owned?: boolean | undefined;
  jupyterVersion?: string | undefined;
  kernelspecs?: { name: string; displayName: string; language: string }[] | undefined;
  environment?: { os?: string; arch?: string; runtime?: string } | undefined;
  leaseExpiresAt?: string | undefined;
}

/** The caller's sessions in this class, newest first. */
export async function listSessions(db: Db, scope: ClassScope): Promise<OwnedSession[]> {
  const rows = await db
    .select()
    .from(notebookSessions)
    .where(mine(scope))
    .orderBy(desc(notebookSessions.createdAt), desc(notebookSessions.id))
    .limit(50);
  return rows.map(own);
}

/** One of the caller's sessions in this class; null for anyone else's. */
export async function findSession(
  db: Executor,
  scope: ClassScope,
  sessionId: string,
  options: { lock?: boolean } = {},
): Promise<OwnedSession | null> {
  const query = db
    .select()
    .from(notebookSessions)
    .where(and(mine(scope), eq(notebookSessions.id, sessionId)));
  const [row] = options.lock ? await query.for('update') : await query;
  return row ? own(row) : null;
}

export interface NewSession {
  connection: OwnedConnection;
  revisionId: string;
  runtime: { mode: 'start' | 'attach'; kernelName?: string | undefined };
  lease: { idleTimeoutMin: number; gracePeriodMin: number };
}

export type OpenRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'class_archived' }
  | { ok: false; reason: 'session_exists'; sessionId: string };

/**
 * Inserts a `starting` session for a notebook revision the caller may study in this class
 * (§2, step 4): at most one open session per person, class and revision. The caller sends
 * `open_session` after this commits.
 */
export async function openSession(
  db: Db,
  scope: ClassScope,
  input: NewSession,
  now: Date,
): Promise<{ ok: true; session: OwnedSession } | OpenRefusal> {
  if (scope.archived) return { ok: false, reason: 'class_archived' };
  try {
    return await db.transaction(async (tx) => {
      const [revision] = await tx
        .select({ id: releaseResources.resourceRevisionId })
        .from(releaseResources)
        .innerJoin(resourceRevisions, eq(resourceRevisions.id, releaseResources.resourceRevisionId))
        .where(
          and(
            studyableRows(scope, now),
            eq(releaseResources.resourceRevisionId, input.revisionId),
            eq(resourceRevisions.type, 'notebook'),
          ),
        );
      if (!revision) return { ok: false as const, reason: 'not_found' as const };
      const [row] = await tx
        .insert(notebookSessions)
        .values({
          classId: scope.classId,
          userId: scope.user.id,
          connectionId: input.connection.id,
          connectorId: input.connection.connectorId,
          resourceRevisionId: revision.id,
          state: 'starting',
          // Until the connector reports, a session is owned when the connector starts Jupyter.
          owned: input.runtime.mode === 'start',
          runtime: input.runtime,
          lease: input.lease,
          kernelName: input.runtime.kernelName ?? null,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error('session insert returned no row');
      await audit(tx, {
        actorId: scope.user.id,
        action: 'session.opened',
        scopeKind: 'class',
        scopeId: scope.classId,
        targetType: 'notebook_session',
        targetId: row.id,
        after: {
          connectionId: input.connection.id,
          resourceRevisionId: revision.id,
          mode: input.runtime.mode,
        },
        createdAt: now,
      });
      return { ok: true as const, session: own(row) };
    });
  } catch (err) {
    if (!uniqueViolation(err, 'notebook_sessions_open_key')) throw err;
    const [open] = await db
      .select({ id: notebookSessions.id })
      .from(notebookSessions)
      .where(
        and(
          mine(scope),
          eq(notebookSessions.resourceRevisionId, input.revisionId),
          inArray(notebookSessions.state, [...OPEN_STATES]),
        ),
      );
    if (!open) throw err;
    return { ok: false, reason: 'session_exists', sessionId: open.id };
  }
}

/** The result of applying an event: the row after it, and whether the state changed. */
export interface Applied {
  session: SessionRow;
  changed: boolean;
  /** The state before the event. */
  before: { state: SessionState; cause: string | null };
}

/**
 * Applies `event` to a locked session row: the state by `nextSessionState`, the reported
 * details whenever the session is open, and the audit event when it stops.
 */
async function applyLocked(
  tx: Tx,
  row: SessionRow,
  event: SessionEvent,
  report: SessionReport | undefined,
  actorId: string | null,
  now: Date,
): Promise<Applied> {
  const before = { state: row.state, cause: row.cause };
  const next = nextSessionState(before, event);
  const details =
    report && isOpen(row.state)
      ? {
          ...(report.owned !== undefined && { owned: report.owned }),
          ...(report.jupyterVersion && { jupyterVersion: report.jupyterVersion }),
          ...(report.environment && { environment: report.environment }),
          ...(report.kernelspecs && {
            runtime: { ...row.runtime, kernelspecs: report.kernelspecs },
          }),
          ...(report.leaseExpiresAt && { leaseExpiresAt: new Date(report.leaseExpiresAt) }),
          lastConfirmedAt: now,
        }
      : {};
  const changed = next !== null && (next.state !== row.state || next.cause !== row.cause);
  if (!changed && Object.keys(details).length === 0) return { session: row, changed, before };
  const closing = changed && next && !isOpen(next.state);
  const [updated] = await tx
    .update(notebookSessions)
    .set({
      ...details,
      ...(changed && next && { state: next.state, cause: next.cause }),
      ...(closing && { stoppedAt: now }),
    })
    .where(eq(notebookSessions.id, row.id))
    .returning();
  if (!updated) throw new Error('session vanished inside its transaction');
  if (closing && next?.state === 'stopped') {
    await audit(tx, {
      actorId,
      action: 'session.stopped',
      scopeKind: 'class',
      scopeId: row.classId,
      targetType: 'notebook_session',
      targetId: row.id,
      before: { state: row.state },
      after: { cause: next.cause },
      createdAt: now,
    });
  }
  return { session: updated, changed, before };
}

/** Applies a person's own event (stop sent, Forget) to one of their sessions. */
export function applyOwnEvent(
  db: Db,
  scope: ClassScope,
  sessionId: string,
  event: SessionEvent,
  now: Date,
): Promise<Applied | null> {
  return db.transaction(async (tx) => {
    const row = await findSession(tx, scope, sessionId, { lock: true });
    if (!row) return null;
    return applyLocked(tx, row, event, undefined, scope.user.id, now);
  });
}

/**
 * Applies an event about one session of `connectorId`: what that connector reported on its own
 * authenticated link, or a deadline the relay keeps for it. Null when the session is not one of
 * that connector's (§10.4: such a message is dropped and counted).
 */
export function applyConnectorEvent(
  db: Db,
  connectorId: string,
  sessionId: string,
  event: SessionEvent,
  now: Date,
  report?: SessionReport,
): Promise<Applied | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(notebookSessions)
      .where(and(eq(notebookSessions.connectorId, connectorId), eq(notebookSessions.id, sessionId)))
      .for('update');
    if (!row) return null;
    return applyLocked(tx, row, event, report, null, now);
  });
}

/** Applies `event` to every open session of one connector, or of every connector. */
async function applyToOpen(
  db: Executor,
  event: SessionEvent,
  now: Date,
  connectorId?: string,
): Promise<string[]> {
  const run = async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(notebookSessions)
      .where(
        and(
          inArray(notebookSessions.state, [...OPEN_STATES]),
          connectorId ? eq(notebookSessions.connectorId, connectorId) : undefined,
        ),
      )
      .for('update');
    const changed: string[] = [];
    for (const row of rows) {
      if ((await applyLocked(tx, row, event, undefined, null, now)).changed) changed.push(row.id);
    }
    return changed;
  };
  // Inside a caller's transaction this is a savepoint.
  return db.transaction(run);
}

/** The link closed or went 45 s without a heartbeat: open sessions become `unconfirmed`. */
export const markLinkLost = (db: Db, connectorId: string, now: Date) =>
  applyToOpen(db, { t: 'link_lost' }, now, connectorId);

/** The connector was revoked (inside the revoking transaction): sessions become unconfirmed. */
export const markConnectorRevoked = (tx: Tx, connectorId: string, now: Date) =>
  applyToOpen(tx, { t: 'revoked' }, now, connectorId);

/**
 * This relay process started: no session was heard from by it, so open ones are unconfirmed
 * until their connector reports (§10.7).
 */
export const markRelayStart = (db: Db, now: Date) => applyToOpen(db, { t: 'relay_start' }, now);

/** One connector's open sessions and the sessions its heartbeat named, whatever their state. */
export function connectorSessions(
  db: Db,
  connectorId: string,
  listed: string[],
): Promise<SessionRow[]> {
  return db
    .select()
    .from(notebookSessions)
    .where(
      and(
        eq(notebookSessions.connectorId, connectorId),
        or(
          inArray(notebookSessions.state, [...OPEN_STATES]),
          listed.length > 0 ? inArray(notebookSessions.id, listed) : undefined,
        ),
      ),
    );
}

/** Records a heartbeat's evidence for the listed open sessions (§9 "Server view"). */
export async function recordHeartbeat(
  db: Db,
  connectorId: string,
  entries: { sessionId: string; leaseExpiresAt?: string | undefined }[],
  now: Date,
): Promise<void> {
  for (const entry of entries) {
    await db
      .update(notebookSessions)
      .set({
        lastHeartbeatAt: now,
        ...(entry.leaseExpiresAt && { leaseExpiresAt: new Date(entry.leaseExpiresAt) }),
      })
      .where(
        and(
          eq(notebookSessions.connectorId, connectorId),
          eq(notebookSessions.id, entry.sessionId),
          inArray(notebookSessions.state, [...OPEN_STATES]),
        ),
      );
  }
}
