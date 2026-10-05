import { createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { UserScope } from '../../auth/scope';
import type { Db, Executor, Tx } from '../client';
import { connectorPairings } from '../schema';
import { forUser } from '../scoped';

/** A pairing code is valid this long after it is issued (docs/design/connector.md §3). */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Live codes one person may hold; a further code supersedes the oldest. */
export const LIVE_CODES_PER_PERSON = 3;

/** Crockford base 32: `0-9 A-Z` without `I L O U`. Eight symbols carry 40 bits. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** A fresh code as shown to the person, `K7M2-Q9XD`. */
export function newPairingCode(): string {
  const bits = randomBytes(5).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  let code = '';
  for (let i = 7; i >= 0; i--) code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The code as the connector sends it: upper case, hyphens and spaces removed, `O` read as `0`
 * and `I`/`L` as `1`. Null when what is left is not eight Crockford symbols.
 */
export function normalisePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE.test(code) ? code : null;
}

/** `K = HMAC-SHA256(SESSION_SECRET, "parallax-pairing-v1")`: no new secret to configure. */
export const pairingKey = (sessionSecret: string): Buffer =>
  createHmac('sha256', sessionSecret).update('parallax-pairing-v1').digest();

/** What is stored for a normalised code: `HMAC-SHA256(K, code)`. */
export const hashPairingCode = (key: Buffer, code: string): Buffer =>
  createHmac('sha256', key).update(code).digest();

/** Serialises one person's connector and pairing changes, so their limits hold under races. */
export const lockOwner = (tx: Tx, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`connectors:${userId}`}, 0))`);

const live = (now: Date) =>
  and(isNull(connectorPairings.usedAt), gt(connectorPairings.expiresAt, now));

/**
 * Issues a pairing code for the scope's person. Only its HMAC is stored; the code is returned
 * once. Holding three live codes already, the oldest stops working.
 */
export async function createPairing(db: Db, scope: UserScope, key: Buffer, now: Date) {
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  return db.transaction(async (tx) => {
    await lockOwner(tx, scope.user.id);
    const held = await tx
      .select({ id: connectorPairings.id })
      .from(connectorPairings)
      .where(and(forUser(scope, connectorPairings), live(now)))
      .orderBy(asc(connectorPairings.createdAt), asc(connectorPairings.id));
    for (const old of held.slice(0, Math.max(0, held.length - LIVE_CODES_PER_PERSON + 1))) {
      await tx
        .update(connectorPairings)
        .set({ expiresAt: now })
        .where(eq(connectorPairings.id, old.id));
    }
    const [row] = await tx
      .insert(connectorPairings)
      .values({
        ownerUserId: scope.user.id,
        codeHash: hashPairingCode(key, normalisePairingCode(code) as string),
        expiresAt,
        createdAt: now,
      })
      .returning({ id: connectorPairings.id });
    if (!row) throw new Error('pairing insert returned no row');
    return { pairingId: row.id, code, expiresAt };
  });
}

/**
 * Spends a live code: marks it used and returns whose it was, or null for an unknown, used or
 * expired code. One statement, so two connectors racing for a code cannot both get it.
 */
export async function consumePairing(tx: Executor, key: Buffer, code: string, now: Date) {
  const [row] = await tx
    .update(connectorPairings)
    .set({ usedAt: now })
    .where(and(eq(connectorPairings.codeHash, hashPairingCode(key, code)), live(now)))
    .returning({ id: connectorPairings.id, ownerUserId: connectorPairings.ownerUserId });
  return row ?? null;
}

/** Records which connector a spent code created. */
export const linkPairing = (tx: Tx, pairingId: string, connectorId: string) =>
  tx.update(connectorPairings).set({ connectorId }).where(eq(connectorPairings.id, pairingId));

/** Deletes used and expired codes (maintenance job); returns how many. */
export async function purgePairings(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(connectorPairings)
    .where(or(isNotNull(connectorPairings.usedAt), lte(connectorPairings.expiresAt, now)))
    .returning({ id: connectorPairings.id });
  return gone.length;
}
