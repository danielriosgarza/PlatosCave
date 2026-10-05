import { randomBytes } from 'node:crypto';
import type { LinkCloseReason } from '@parallax/contracts';
import type { Db } from '../db/client';
import { findLinkConnector, type LinkConnectorRow } from '../db/connectors/registry';
import { linkMessage, SIGNATURE_WINDOW_SECONDS, verifySignature } from './signing';

/**
 * Link authentication (docs/design/connector.md §4.2): the server's challenge, the check of the
 * connector's signed answer, and the checks of its `hello`. Every refusal names the close
 * reason of §4.6. A bad signature and an unknown connector id are both `bad_signature`, and the
 * signature is checked before the connector's state is told, so ids cannot be probed.
 */

/** A challenge is valid this long after it was sent, and only once (§4.2). */
export const CHALLENGE_TTL_MS = 30_000;

export class Challenge {
  /** 32 random bytes. */
  readonly nonce = randomBytes(32);
  private used = false;

  constructor(readonly issuedAt: Date) {}

  /** Spends the challenge: true once, while it is unexpired. */
  spend(now: Date): boolean {
    if (this.used) return false;
    this.used = true;
    return now.getTime() - this.issuedAt.getTime() <= CHALLENGE_TTL_MS;
  }
}

export interface LinkAuthAnswer {
  connectorId: string;
  ts: number;
  sig: string;
}

export type LinkAuthResult =
  | { ok: true; connector: LinkConnectorRow }
  | {
      ok: false;
      reason: Extract<
        LinkCloseReason,
        'protocol_error' | 'clock_skew' | 'bad_signature' | 'pending' | 'revoked'
      >;
    };

/**
 * Checks an `auth` answer to `challenge`: the challenge unexpired and unused, `ts` within 120 s
 * of `now`, the signature of the stored key over the link layout with this server's `origin`,
 * and only then the connector's state. A pending connector past its approval window is as
 * good as revoked: it has to pair again.
 */
export async function authenticateLink(
  db: Db,
  challenge: Challenge,
  answer: LinkAuthAnswer,
  origin: string,
  now: Date,
): Promise<LinkAuthResult> {
  if (!challenge.spend(now)) return { ok: false, reason: 'protocol_error' };
  if (Math.abs(now.getTime() / 1000 - answer.ts) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: 'clock_skew' };
  }
  const row = await findLinkConnector(db, answer.connectorId);
  const message = linkMessage(challenge.nonce, answer.connectorId, answer.ts, origin);
  if (!row || !verifySignature(message, row.publicKey, answer.sig)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (row.status === 'pending') {
    const lapsed = row.approveBy !== null && row.approveBy.getTime() <= now.getTime();
    return { ok: false, reason: lapsed ? 'revoked' : 'pending' };
  }
  return { ok: true, connector: row };
}

/** `-1`, `0` or `1` as semantic version `a` is below, equal to or above `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split(/-(.*)/s, 2);
    return { core: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  // A pre-release sorts before its release; two pre-releases of one release are compared as text.
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The checks of `hello` (§4.2): its mode must be the row's, and its version at least
 * `minVersion` when the server sets one.
 */
export function checkHello(
  connector: Pick<LinkConnectorRow, 'mode'>,
  hello: { mode: string; version: string },
  minVersion: string | undefined,
): Extract<LinkCloseReason, 'mode_mismatch' | 'upgrade_required'> | null {
  if (hello.mode !== connector.mode) return 'mode_mismatch';
  if (minVersion && compareVersions(hello.version, minVersion) < 0) return 'upgrade_required';
  return null;
}
