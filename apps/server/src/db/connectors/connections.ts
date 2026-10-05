import { type LinkRuntime, validateTarget } from '@parallax/contracts';
import type { ConnectionTarget } from '@parallax/contracts/routes/connections';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import type { ClassScope, UserScope } from '../../auth/scope';
import { checkTargetPolicy, type NetworkScope } from '../../relay/netpolicy';
import { audit } from '../audit';
import type { Db, Tx } from '../client';
import {
  classComputeTemplates,
  classMemberships,
  connectors,
  notebookConnections,
  notebookSessions,
  type TrustedHostKey,
} from '../schema';
import { forUser } from '../scoped';
import { uniqueViolation } from '../unique';

/**
 * Saved connections (docs/design/connector.md §2, §10.2): a person's own, secret-free target
 * references, user-owned across classes. Every function filters by the caller's own id; the
 * values they return are the only way to name a connection's connector to the relay (§10.4).
 */

declare const ownedConnection: unique symbol;

export type ConnectionRow = typeof notebookConnections.$inferSelect;

/**
 * A connection read through the caller's scope. The brand cannot be named outside this module, so
 * relay code holding one got it from a function that checked the owner (§10.4).
 */
export type OwnedConnection = Omit<ConnectionRow, 'target' | 'runtime'> & {
  readonly [ownedConnection]: true;
  target: ConnectionTarget;
  runtime: LinkRuntime;
};

const own = (row: ConnectionRow) => row as unknown as OwnedConnection;

/** States in which a session still holds its connection. */
const CLOSED_STATES = ['stopped', 'failed'] as const;

export type ConnectionRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'connector_not_active' }
  | { ok: false; reason: 'name_taken' }
  | {
      ok: false;
      reason: 'target_not_allowed';
      code: 'invalid_target' | 'network_scope_denied';
      rules?: number[];
    };

const isNameTaken = (err: unknown) => uniqueViolation(err, 'notebook_connections_owner_name_key');

/** The connection event of §10.2, in the owner's user scope. */
const connectionEvent = (
  scope: UserScope,
  action:
    | 'connection.created'
    | 'connection.updated'
    | 'connection.archived'
    | 'connection.host_key_trusted'
    | 'connection.host_key_replaced',
  connectionId: string,
  before: object | null,
  after: object | null,
  createdAt: Date,
) => ({
  actorId: scope.user.id,
  action,
  scopeKind: 'user' as const,
  scopeId: scope.user.id,
  targetType: 'connection',
  targetId: connectionId,
  before,
  after,
  createdAt,
});

/** What the audit trail keeps of a target: its kind, host and user, never a key path (§10.2). */
const summary = (target: ConnectionTarget) =>
  target.kind === 'ssh'
    ? {
        kind: target.kind,
        host: target.host,
        port: target.port,
        user: target.user,
        ...(target.jump && { jump: { host: target.jump.host, port: target.jump.port } }),
      }
    : { kind: target.kind };

/** The caller's unarchived connections, newest first. */
export async function listConnections(db: Db, scope: UserScope): Promise<OwnedConnection[]> {
  const rows = await db
    .select()
    .from(notebookConnections)
    .where(and(forUser(scope, notebookConnections), isNull(notebookConnections.archivedAt)))
    .orderBy(desc(notebookConnections.createdAt), desc(notebookConnections.id));
  return rows.map(own);
}

/** One of the caller's unarchived connections; null for anyone else's. */
export async function findConnection(
  db: Db | Tx,
  scope: UserScope,
  connectionId: string,
  options: { lock?: boolean } = {},
): Promise<OwnedConnection | null> {
  const query = db
    .select()
    .from(notebookConnections)
    .where(
      and(
        forUser(scope, notebookConnections),
        eq(notebookConnections.id, connectionId),
        isNull(notebookConnections.archivedAt),
      ),
    );
  const [row] = options.lock ? await query.for('update') : await query;
  return row ? own(row) : null;
}

/** The caller's own active connector and the scope it reported, for a target check. */
async function activeConnector(tx: Tx, scope: UserScope, connectorId: string) {
  const [row] = await tx
    .select({ id: connectors.id, status: connectors.status, networkScope: connectors.networkScope })
    .from(connectors)
    .where(and(forUser(scope, connectors), eq(connectors.id, connectorId)));
  return row;
}

/** Every rule of §4.4 for the target and runtime, then the connector's scope (§8). */
function policy(
  target: ConnectionTarget,
  runtime: LinkRuntime,
  networkScope: NetworkScope,
): ConnectionRefusal | null {
  const issues = validateTarget({ target, runtime });
  if (issues.length > 0) {
    const rules = [...new Set(issues.map((i) => i.rule))].sort();
    return { ok: false, reason: 'target_not_allowed', code: 'invalid_target', rules };
  }
  const checked = checkTargetPolicy(target, networkScope);
  return checked.ok ? null : { ok: false, reason: 'target_not_allowed', code: checked.code };
}

export interface NewConnection {
  name: string;
  connectorId: string;
  target: ConnectionTarget;
  runtime: LinkRuntime;
  templateId?: string | undefined;
}

/**
 * Saves a connection of the caller (§2, step 2). The connector must be the caller's own and
 * active; a template must belong to a class the caller is a member of. The target is checked
 * against rules 1–2 of §4.4 and the connector's reported scope (§8) before it is stored.
 */
export async function createConnection(
  db: Db,
  scope: UserScope,
  input: NewConnection,
  now: Date,
): Promise<{ ok: true; connection: OwnedConnection } | ConnectionRefusal> {
  try {
    return await db.transaction(async (tx) => {
      const connector = await activeConnector(tx, scope, input.connectorId);
      if (!connector) return { ok: false as const, reason: 'not_found' as const };
      if (connector.status !== 'active') {
        return { ok: false as const, reason: 'connector_not_active' as const };
      }
      if (input.templateId && !(await usableTemplate(tx, scope, input.templateId))) {
        return { ok: false as const, reason: 'not_found' as const };
      }
      const refused = policy(input.target, input.runtime, connector.networkScope);
      if (refused) return refused;
      const [row] = await tx
        .insert(notebookConnections)
        .values({
          ownerUserId: scope.user.id,
          connectorId: connector.id,
          name: input.name,
          target: input.target,
          runtime: input.runtime,
          templateId: input.templateId ?? null,
          trustedHostKeys: [],
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('connection insert returned no row');
      await audit(
        tx,
        connectionEvent(
          scope,
          'connection.created',
          row.id,
          null,
          { name: input.name, connectorId: connector.id, target: summary(input.target) },
          now,
        ),
      );
      return { ok: true as const, connection: own(row) };
    });
  } catch (err) {
    if (isNameTaken(err)) return { ok: false, reason: 'name_taken' };
    throw err;
  }
}

/** An unarchived template of a class the caller belongs to (as a real member, not a preview). */
async function usableTemplate(tx: Tx, scope: UserScope, templateId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: classComputeTemplates.id })
    .from(classComputeTemplates)
    .innerJoin(
      classMemberships,
      and(
        eq(classMemberships.classId, classComputeTemplates.classId),
        eq(classMemberships.userId, scope.user.id),
        eq(classMemberships.isPreview, false),
      ),
    )
    .where(and(eq(classComputeTemplates.id, templateId), isNull(classComputeTemplates.archivedAt)));
  return row !== undefined;
}

const endpoints = (target: ConnectionTarget) =>
  target.kind === 'ssh'
    ? [
        { host: target.host, port: target.port },
        ...(target.jump ? [{ host: target.jump.host, port: target.jump.port }] : []),
      ]
    : [];

const sameEndpoint = (a: { host: string; port: number }, b: { host: string; port: number }) =>
  a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;

/** The trusted keys a target still names: a changed host, port or jump host drops the rest. */
export const keysCovered = (keys: TrustedHostKey[], target: ConnectionTarget) =>
  keys.filter((k) => endpoints(target).some((e) => sameEndpoint(e, k)));

export interface ConnectionChange {
  name?: string | undefined;
  target?: ConnectionTarget | undefined;
  runtime?: LinkRuntime | undefined;
}

/**
 * Renames a connection or changes its target or runtime. A new target is checked as on create
 * and keeps only the trusted host keys it still names (§10.3).
 */
export async function updateConnection(
  db: Db,
  scope: UserScope,
  connectionId: string,
  change: ConnectionChange,
  now: Date,
): Promise<{ ok: true; connection: OwnedConnection } | ConnectionRefusal> {
  try {
    return await db.transaction(async (tx) => {
      const current = await findConnection(tx, scope, connectionId, { lock: true });
      if (!current) return { ok: false as const, reason: 'not_found' as const };
      const target = change.target ?? current.target;
      const runtime = change.runtime ?? current.runtime;
      if (change.target || change.runtime) {
        const connector = await activeConnector(tx, scope, current.connectorId);
        const scopeOf = connector?.networkScope ?? { cidrs: [], hosts: [] };
        const refused = policy(target, runtime, scopeOf);
        if (refused) return refused;
      }
      const trustedHostKeys = keysCovered(current.trustedHostKeys, target);
      const [row] = await tx
        .update(notebookConnections)
        .set({
          ...(change.name !== undefined && { name: change.name }),
          target,
          runtime,
          trustedHostKeys,
          updatedAt: now,
        })
        .where(eq(notebookConnections.id, current.id))
        .returning();
      if (!row) throw new Error('connection vanished inside its transaction');
      const dropped = current.trustedHostKeys.length - trustedHostKeys.length;
      await audit(
        tx,
        connectionEvent(
          scope,
          'connection.updated',
          row.id,
          { name: current.name, target: summary(current.target) },
          {
            name: row.name,
            target: summary(target),
            ...(dropped > 0 && { hostKeysDropped: dropped }),
          },
          now,
        ),
      );
      return { ok: true as const, connection: own(row) };
    });
  } catch (err) {
    if (isNameTaken(err)) return { ok: false, reason: 'name_taken' };
    throw err;
  }
}

/** Archives a connection; refused while one of its sessions is open. */
export function archiveConnection(
  db: Db,
  scope: UserScope,
  connectionId: string,
  now: Date,
): Promise<
  | { ok: true; connection: OwnedConnection }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; sessionId: string }
> {
  return db.transaction(async (tx) => {
    const current = await findConnection(tx, scope, connectionId, { lock: true });
    if (!current) return { ok: false as const, reason: 'not_found' as const };
    // The session row belongs to the connection's owner, so this reads only the caller's data.
    const [open] = await tx
      .select({ id: notebookSessions.id })
      .from(notebookSessions)
      .where(
        and(
          eq(notebookSessions.connectionId, current.id),
          eq(notebookSessions.userId, scope.user.id),
          notInArray(notebookSessions.state, [...CLOSED_STATES]),
        ),
      )
      .limit(1);
    if (open) return { ok: false as const, reason: 'in_use' as const, sessionId: open.id };
    const [row] = await tx
      .update(notebookConnections)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(notebookConnections.id, current.id))
      .returning();
    if (!row) throw new Error('connection vanished inside its transaction');
    await audit(
      tx,
      connectionEvent(scope, 'connection.archived', row.id, { name: row.name }, null, now),
    );
    return { ok: true as const, connection: own(row) };
  });
}

/** A hop the connector listed in `data.hops` of a `host_identity` stage (§5.2). */
export interface ListedHop {
  hop: 'jump' | 'target';
  fingerprint: string;
}

/** A replacement the server accepted for this test: recent sign-in, `replacing` matched. */
export interface AcceptedReplacement {
  host: string;
  port: number;
  sha256: string;
}

/**
 * Stores host keys from a `host_identity` report by the rules of §5.2 "Server side". `sent` is
 * the target the test sent; a hop whose `host:port` the connection no longer names is ignored.
 * A hop with no record is stored; an equal record is left; a differing record is replaced only
 * by an accepted replacement for that key, and otherwise kept. Returns the keys now trusted.
 */
export function recordHostKeys(
  db: Db,
  scope: UserScope,
  connectionId: string,
  input: { sent: ConnectionTarget; hops: ListedHop[]; replacements: AcceptedReplacement[] },
  now: Date,
): Promise<TrustedHostKey[] | null> {
  return db.transaction(async (tx) => {
    const current = await findConnection(tx, scope, connectionId, { lock: true });
    if (!current || input.sent.kind !== 'ssh') return null;
    const sent = input.sent;
    const keys = [...current.trustedHostKeys];
    const events: ReturnType<typeof connectionEvent>[] = [];
    for (const listed of input.hops) {
      const hop = listed.hop === 'target' ? sent : sent.jump;
      if (!hop) continue;
      const endpoint = { host: hop.host, port: hop.port };
      // Only for a host:port this connection still names (a PATCH may have moved it meanwhile).
      if (!endpoints(current.target).some((e) => sameEndpoint(e, endpoint))) continue;
      const at = keys.findIndex((k) => sameEndpoint(k, endpoint));
      const record = keys[at];
      const key = { ...endpoint, sha256: listed.fingerprint, confirmedAt: now.toISOString() };
      if (!record) {
        keys.push(key);
        events.push(
          connectionEvent(scope, 'connection.host_key_trusted', current.id, null, key, now),
        );
        continue;
      }
      if (record.sha256 === listed.fingerprint) continue;
      const accepted = input.replacements.some(
        (r) => sameEndpoint(r, endpoint) && r.sha256 === listed.fingerprint,
      );
      if (!accepted) continue;
      keys[at] = key;
      events.push(
        connectionEvent(
          scope,
          'connection.host_key_replaced',
          current.id,
          { host: record.host, port: record.port, sha256: record.sha256 },
          key,
          now,
        ),
      );
    }
    if (events.length === 0) return current.trustedHostKeys;
    await tx
      .update(notebookConnections)
      .set({ trustedHostKeys: keys, updatedAt: now })
      .where(eq(notebookConnections.id, current.id));
    await audit(tx, events);
    return keys;
  });
}

/** What Connect needs to know about a connection, read for the caller's class scope. */
export interface SessionConnection {
  connection: OwnedConnection;
  connector: { status: 'pending' | 'active' | 'revoked'; networkScope: NetworkScope };
  /** The class of the template the connection was made from, if any. */
  templateClassId: string | null;
}

/**
 * The caller's own unarchived connection with its connector, for opening a session in a class
 * (§2, step 4). Null for anyone else's, whatever the caller's role in the class (A33).
 */
export async function connectionForSession(
  db: Db | Tx,
  scope: ClassScope,
  connectionId: string,
): Promise<SessionConnection | null> {
  const [row] = await db
    .select({
      connection: notebookConnections,
      status: connectors.status,
      networkScope: connectors.networkScope,
      templateClassId: classComputeTemplates.classId,
    })
    .from(notebookConnections)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, notebookConnections.connectorId),
        eq(connectors.ownerUserId, scope.user.id),
      ),
    )
    .leftJoin(classComputeTemplates, eq(classComputeTemplates.id, notebookConnections.templateId))
    .where(
      and(
        eq(notebookConnections.ownerUserId, scope.user.id),
        eq(notebookConnections.id, connectionId),
        isNull(notebookConnections.archivedAt),
      ),
    );
  if (!row) return null;
  return {
    connection: own(row.connection),
    connector: { status: row.status, networkScope: row.networkScope },
    templateClassId: row.templateClassId,
  };
}
