import { and, count, desc, eq, inArray, lte } from 'drizzle-orm';
import type { UserScope } from '../../auth/scope';
import { fingerprintOf } from '../../relay/signing';
import { audit } from '../audit';
import type { Db, Executor, Tx } from '../client';
import { connectors } from '../schema';
import { forUser } from '../scoped';
import { consumePairing, linkPairing, lockOwner } from './pairing';

/** A pending connector must be approved within this time of pairing (§3). */
export const APPROVAL_WINDOW_MS = 15 * 60_000;
/** Connectors one person may hold (§3). */
export const MAX_ACTIVE_CONNECTORS = 5;
export const MAX_PENDING_CONNECTORS = 3;

export type RevokedReason = NonNullable<(typeof connectors.$inferSelect)['revokedReason']>;

const viewColumns = {
  id: connectors.id,
  name: connectors.name,
  os: connectors.os,
  arch: connectors.arch,
  version: connectors.version,
  fingerprint: connectors.fingerprint,
  status: connectors.status,
  mode: connectors.mode,
  lastSeenAt: connectors.lastSeenAt,
  createdAt: connectors.createdAt,
  approveBy: connectors.approveBy,
  networkScope: connectors.networkScope,
};
export type ConnectorRow = {
  [K in keyof typeof viewColumns]: (typeof connectors.$inferSelect)[K];
};

/** An audit event of §10.2: user scope, or system for a managed connector, which has no owner. */
const connectorEvent = (
  actorId: string | null,
  ownerUserId: string | null,
  action: 'connector.paired' | 'connector.approved' | 'connector.revoked',
  connectorId: string,
  before: object | null,
  after: object,
) => ({
  actorId,
  action,
  scopeKind: ownerUserId ? ('user' as const) : ('system' as const),
  scopeId: ownerUserId,
  targetType: 'connector',
  targetId: connectorId,
  before,
  after,
});

/**
 * Revokes the pending connectors whose approval window closed at or before `now` (reason
 * `expired`), for one person or for everyone. Returns the ids it expired.
 */
export async function expirePendingConnectors(
  db: Executor,
  now: Date,
  ownerUserId?: string,
): Promise<string[]> {
  const rows = await db
    .update(connectors)
    .set({ status: 'revoked', approveBy: null, revokedAt: now, revokedReason: 'expired' })
    .where(
      and(
        eq(connectors.status, 'pending'),
        lte(connectors.approveBy, now),
        ownerUserId ? eq(connectors.ownerUserId, ownerUserId) : undefined,
      ),
    )
    .returning({ id: connectors.id });
  return rows.map((r) => r.id);
}

const countByStatus = async (tx: Tx, ownerUserId: string, status: 'pending' | 'active') => {
  const [row] = await tx
    .select({ n: count() })
    .from(connectors)
    .where(and(eq(connectors.ownerUserId, ownerUserId), eq(connectors.status, status)));
  return row?.n ?? 0;
};

export interface PairInput {
  /** Normalised pairing code. */
  code: string;
  publicKey: Buffer;
  name: string;
  os: string;
  arch: string;
  version: string;
}

export type PairResult =
  | { ok: true; connectorId: string; fingerprint: string; approveBy: Date }
  | { ok: false; reason: 'not_found' | 'too_many_pending' | 'key_in_use' };

class Refused extends Error {
  constructor(readonly reason: 'too_many_pending' | 'key_in_use') {
    super(reason);
  }
}

/**
 * Spends a pairing code and creates the pending personal connector it pairs (§3, step 3). A
 * refusal after the code was found (three pending devices already, or a key already paired)
 * rolls the spend back, so the person can resolve it and use the same code.
 */
export async function createPendingConnector(
  db: Db,
  key: Buffer,
  input: PairInput,
  now: Date,
): Promise<PairResult> {
  const fingerprint = fingerprintOf(input.publicKey);
  try {
    return await db.transaction(async (tx) => {
      const pairing = await consumePairing(tx, key, input.code, now);
      if (!pairing) return { ok: false as const, reason: 'not_found' as const };
      const owner = pairing.ownerUserId;
      await lockOwner(tx, owner);
      await expirePendingConnectors(tx, now, owner);
      if ((await countByStatus(tx, owner, 'pending')) >= MAX_PENDING_CONNECTORS) {
        throw new Refused('too_many_pending');
      }
      const [taken] = await tx
        .select({ id: connectors.id })
        .from(connectors)
        .where(eq(connectors.fingerprint, fingerprint));
      if (taken) throw new Refused('key_in_use');
      const approveBy = new Date(now.getTime() + APPROVAL_WINDOW_MS);
      const [row] = await tx
        .insert(connectors)
        .values({
          ownerUserId: owner,
          name: input.name,
          mode: 'personal',
          status: 'pending',
          publicKey: input.publicKey,
          fingerprint,
          os: input.os,
          arch: input.arch,
          version: input.version,
          approveBy,
          createdAt: now,
        })
        .returning({ id: connectors.id });
      if (!row) throw new Error('connector insert returned no row');
      await linkPairing(tx, pairing.id, row.id);
      await audit(
        tx,
        connectorEvent(owner, owner, 'connector.paired', row.id, null, {
          name: input.name,
          fingerprint,
          os: input.os,
          arch: input.arch,
          version: input.version,
        }),
      );
      return { ok: true as const, connectorId: row.id, fingerprint, approveBy };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** The person's pending and active connectors, newest first; lapsed approvals expire first. */
export async function listConnectors(db: Db, scope: UserScope, now: Date): Promise<ConnectorRow[]> {
  await expirePendingConnectors(db, now, scope.user.id);
  return db
    .select(viewColumns)
    .from(connectors)
    .where(and(forUser(scope, connectors), inArray(connectors.status, ['pending', 'active'])))
    .orderBy(desc(connectors.createdAt), desc(connectors.id));
}

/** One of the person's own connectors, locked for the change; none for anyone else's. */
async function ownConnector(tx: Tx, scope: UserScope, connectorId: string) {
  const [row] = await tx
    .select({ ...viewColumns, approvedAt: connectors.approvedAt })
    .from(connectors)
    .where(and(forUser(scope, connectors), eq(connectors.id, connectorId)))
    .for('update');
  return row;
}

const view = async (tx: Tx, connectorId: string): Promise<ConnectorRow> => {
  const [row] = await tx.select(viewColumns).from(connectors).where(eq(connectors.id, connectorId));
  if (!row) throw new Error('connector vanished inside its transaction');
  return row;
};

export type ApproveResult =
  | { ok: true; connector: ConnectorRow }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'too_many_connectors' };

/**
 * Approves a pending connector of the scope's person (§3, step 5). The route has already
 * required a recent sign-in. Approving an active connector again changes nothing.
 */
export function approveConnector(
  db: Db,
  scope: UserScope,
  connectorId: string,
  now: Date,
): Promise<ApproveResult> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, scope.user.id);
    await expirePendingConnectors(tx, now, scope.user.id);
    const row = await ownConnector(tx, scope, connectorId);
    if (!row) return { ok: false as const, reason: 'not_found' as const };
    if (row.status === 'active') return { ok: true as const, connector: await view(tx, row.id) };
    if (row.status !== 'pending') return { ok: false as const, reason: 'not_pending' as const };
    if ((await countByStatus(tx, scope.user.id, 'active')) >= MAX_ACTIVE_CONNECTORS) {
      return { ok: false as const, reason: 'too_many_connectors' as const };
    }
    await tx
      .update(connectors)
      .set({ status: 'active', approveBy: null, approvedAt: now })
      .where(eq(connectors.id, row.id));
    await audit(
      tx,
      connectorEvent(
        scope.user.id,
        scope.user.id,
        'connector.approved',
        row.id,
        { status: 'pending' },
        {
          status: 'active',
          fingerprint: row.fingerprint,
        },
      ),
    );
    return { ok: true as const, connector: await view(tx, row.id) };
  });
}

/**
 * Revokes a connector of the scope's person: rejects a pending one (reason `rejected`) or
 * revokes an active one (`user`). Revoking a revoked connector changes nothing. The caller
 * closes its live link; sessions on it are marked from P3-06 on.
 */
export function revokeConnector(
  db: Db,
  scope: UserScope,
  connectorId: string,
  now: Date,
): Promise<{ ok: true; connector: ConnectorRow; revoked: boolean } | { ok: false }> {
  return db.transaction(async (tx) => {
    const row = await ownConnector(tx, scope, connectorId);
    if (!row) return { ok: false as const };
    if (row.status === 'revoked') {
      return { ok: true as const, connector: await view(tx, row.id), revoked: false };
    }
    const reason: RevokedReason = row.status === 'pending' ? 'rejected' : 'user';
    const target = { id: row.id, ownerUserId: scope.user.id, status: row.status };
    await revoke(tx, scope.user.id, target, reason, now);
    return { ok: true as const, connector: await view(tx, row.id), revoked: true };
  });
}

async function revoke(
  tx: Tx,
  actorId: string | null,
  connector: { id: string; ownerUserId: string | null; status: 'pending' | 'active' },
  reason: RevokedReason,
  now: Date,
) {
  await tx
    .update(connectors)
    .set({ status: 'revoked', approveBy: null, revokedAt: now, revokedReason: reason })
    .where(eq(connectors.id, connector.id));
  await audit(
    tx,
    connectorEvent(
      actorId,
      connector.ownerUserId,
      'connector.revoked',
      connector.id,
      { status: connector.status },
      { status: 'revoked', reason },
    ),
  );
}

/** Renames one of the scope's person's connectors. */
export function renameConnector(db: Db, scope: UserScope, connectorId: string, name: string) {
  return db.transaction(async (tx) => {
    const row = await ownConnector(tx, scope, connectorId);
    if (!row || row.status === 'revoked') return null;
    await tx.update(connectors).set({ name }).where(eq(connectors.id, row.id));
    return view(tx, row.id);
  });
}

/**
 * Revokes every pending and active connector of one person (account deactivation, P4-09) with
 * reason `account`, as a system action. Returns the revoked ids, whose links the caller closes.
 */
export function revokeUserConnectors(db: Db, userId: string, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, userId);
    const rows = await tx
      .select({ id: connectors.id, status: connectors.status })
      .from(connectors)
      .where(
        and(eq(connectors.ownerUserId, userId), inArray(connectors.status, ['pending', 'active'])),
      )
      .for('update');
    for (const row of rows) {
      const status = row.status as 'pending' | 'active';
      await revoke(tx, null, { id: row.id, ownerUserId: userId, status }, 'account', now);
    }
    return rows.map((r) => r.id);
  });
}

/**
 * The key and state a signed connector request is checked against. Looked up by the id the
 * request names: the signature, not a session, is the credential, so no scope applies.
 */
export async function findSigningConnector(db: Db, connectorId: string) {
  const [row] = await db
    .select({
      id: connectors.id,
      ownerUserId: connectors.ownerUserId,
      status: connectors.status,
      publicKey: connectors.publicKey,
      approveBy: connectors.approveBy,
      revokedReason: connectors.revokedReason,
    })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  return row ?? null;
}

export type PollStatus = 'pending' | 'active' | 'rejected' | 'expired';

/**
 * What a verified poll answers (§3, step 6): a pending connector past its approval window is
 * expired here, and every revocation other than expiry reads as `rejected`. Records the poll as
 * the connector's last sighting.
 */
export async function pollConnector(db: Db, connectorId: string, now: Date): Promise<PollStatus> {
  return db.transaction(async (tx) => {
    await expirePendingConnectorById(tx, connectorId, now);
    const [row] = await tx
      .update(connectors)
      .set({ lastSeenAt: now })
      .where(eq(connectors.id, connectorId))
      .returning({ status: connectors.status, revokedReason: connectors.revokedReason });
    if (!row) return 'rejected';
    if (row.status === 'revoked') return row.revokedReason === 'expired' ? 'expired' : 'rejected';
    return row.status;
  });
}

const expirePendingConnectorById = (tx: Tx, connectorId: string, now: Date) =>
  tx
    .update(connectors)
    .set({ status: 'revoked', approveBy: null, revokedAt: now, revokedReason: 'expired' })
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.status, 'pending'),
        lte(connectors.approveBy, now),
      ),
    );

/**
 * A verified unpair request (§3): the connector revokes itself (reason `unpair`), acting for
 * its owner. Unpairing a revoked connector changes nothing. Returns whether it was revoked now.
 */
export function unpairConnector(db: Db, connectorId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: connectors.id, status: connectors.status, ownerUserId: connectors.ownerUserId })
      .from(connectors)
      .where(eq(connectors.id, connectorId))
      .for('update');
    if (!row || row.status === 'revoked') return false;
    await revoke(tx, row.ownerUserId, { ...row, status: row.status }, 'unpair', now);
    return true;
  });
}

/**
 * What a link is authenticated and kept alive against (§4.2): the key, the state and the mode.
 * Looked up by the id the `auth` message names; the signature is the credential.
 */
export async function findLinkConnector(db: Db, connectorId: string) {
  const [row] = await db
    .select({
      id: connectors.id,
      status: connectors.status,
      mode: connectors.mode,
      publicKey: connectors.publicKey,
      approveBy: connectors.approveBy,
    })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  return row ?? null;
}
export type LinkConnectorRow = NonNullable<Awaited<ReturnType<typeof findLinkConnector>>>;

/**
 * Stores what an active connector reported in `hello` (§4.2) and when it was seen, for display
 * and for the early rejection of literal addresses (§8). False when the connector is no longer
 * active, so a revocation between `auth` and `hello` keeps the link from going live.
 */
export async function recordLinkHello(
  db: Db,
  connectorId: string,
  hello: {
    os: string;
    arch: string;
    version: string;
    networkScope: { cidrs: string[]; hosts: string[] };
  },
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(connectors)
    .set({ ...hello, lastSeenAt: now })
    .where(and(eq(connectors.id, connectorId), eq(connectors.status, 'active')))
    .returning({ id: connectors.id });
  return rows.length > 0;
}

/**
 * The periodic re-read of a live link's connector (§3 "Revoke and unpair"): records it as seen
 * and answers whether it is still active, so a revocation whose closing notice was lost still
 * ends the link.
 */
export async function touchLinkConnector(db: Db, connectorId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(connectors)
    .set({ lastSeenAt: now })
    .where(and(eq(connectors.id, connectorId), eq(connectors.status, 'active')))
    .returning({ id: connectors.id });
  return rows.length > 0;
}
