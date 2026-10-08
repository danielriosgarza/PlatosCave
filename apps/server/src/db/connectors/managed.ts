import { eq } from 'drizzle-orm';
import { fingerprintOf } from '../../relay/signing';
import { audit } from '../audit';
import { createDb, type Db } from '../client';
import { connectors } from '../schema';

/**
 * Managed connectors (docs/design/connector.md §12). There is no instance-administrator role
 * yet, so an operator registers one with `connectors:register-managed`: an `active` row with
 * `mode = 'managed'` and no owner. No person owns it, so no person's `GET /api/me/connectors`
 * lists it. No template or connection names its targets yet: that waits for the owner's
 * decision on who operates managed connectors (spec §17).
 */

export interface ManagedConnectorInput {
  name: string;
  /** The raw 32-byte Ed25519 public key of the connector's identity. */
  publicKey: Buffer;
}

export type RegisterResult =
  | { ok: true; connectorId: string; fingerprint: string }
  | { ok: false; reason: 'key_in_use' };

/**
 * Inserts the managed connector. Its os, arch and version are placeholders until its first
 * `hello` records what it runs on. A key already registered to any connector is refused.
 */
export async function registerManagedConnector(
  db: Db,
  input: ManagedConnectorInput,
  now: Date,
): Promise<RegisterResult> {
  const fingerprint = fingerprintOf(input.publicKey);
  return db.transaction(async (tx) => {
    const [taken] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.fingerprint, fingerprint));
    if (taken) return { ok: false as const, reason: 'key_in_use' as const };
    const [row] = await tx
      .insert(connectors)
      .values({
        ownerUserId: null,
        name: input.name,
        mode: 'managed',
        status: 'active',
        publicKey: input.publicKey,
        fingerprint,
        os: 'linux',
        arch: 'amd64',
        version: '0.0.0',
        approvedAt: now,
        createdAt: now,
      })
      .returning({ id: connectors.id });
    if (!row) throw new Error('connector insert returned no row');
    // Registration pairs and approves in one step; one event records both.
    await audit(tx, {
      actorId: null,
      action: 'connector.paired',
      scopeKind: 'system',
      scopeId: null,
      targetType: 'connector',
      targetId: row.id,
      before: null,
      after: { name: input.name, fingerprint, mode: 'managed', status: 'active' },
    });
    return { ok: true as const, connectorId: row.id, fingerprint };
  });
}

/** Opens the database at `url` for one call and closes it again: the operator script's handle. */
export async function withDatabase<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, pool } = createDb(url);
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}
