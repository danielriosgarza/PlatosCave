import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

/**
 * The signed byte layouts of connector protocol v1 (docs/design/connector.md §4.2) and their
 * check against a connector's stored Ed25519 public key. Every signature is bound to one purpose
 * (the label), one connector, one time and one server origin; a link signature also to one
 * challenge nonce. `vectors/signing.json` pins the bytes; signing.test.ts reproduces it.
 */

export const LINK_LABEL = 'parallax-connector-link-v1';
export const POLL_LABEL = 'parallax-connector-poll-v1';
export const UNPAIR_LABEL = 'parallax-connector-unpair-v1';

/** How far a signed `ts` may be from the server's clock, either way (§4.2). */
export const SIGNATURE_WINDOW_SECONDS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * `scheme://host[:port]`, lower case, no trailing slash, the default port omitted: the form
 * `pair` stores and both sides sign (§4.2).
 */
export function normaliseOrigin(url: string): string {
  const origin = new URL(url).origin;
  if (origin === 'null') throw new Error(`${url} has no origin`);
  return origin;
}

function message(
  label: string,
  nonce: Buffer | null,
  connectorId: string,
  ts: number,
  origin: string,
) {
  if (!UUID.test(connectorId)) throw new Error('connectorId must be a lower-case uuid');
  if (nonce && nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const id = Buffer.from(connectorId.replaceAll('-', ''), 'hex');
  const time = Buffer.alloc(8);
  time.writeBigInt64BE(BigInt(ts));
  const host = Buffer.from(origin, 'utf8');
  if (host.length > 0xffff) throw new Error('origin is too long');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(host.length);
  return Buffer.concat([
    Buffer.from(`${label}\0`, 'utf8'),
    ...(nonce ? [nonce] : []),
    id,
    time,
    length,
    host,
  ]);
}

/** Bytes a connector signs to answer a link challenge. */
export const linkMessage = (nonce: Buffer, connectorId: string, ts: number, origin: string) =>
  message(LINK_LABEL, nonce, connectorId, ts, origin);
/** Bytes signed by `POST /api/connector/v1/pair/poll`. */
export const pollMessage = (connectorId: string, ts: number, origin: string) =>
  message(POLL_LABEL, null, connectorId, ts, origin);
/** Bytes signed by `POST /api/connector/v1/unpair`. */
export const unpairMessage = (connectorId: string, ts: number, origin: string) =>
  message(UNPAIR_LABEL, null, connectorId, ts, origin);

/** Decodes unpadded base64url, or null when the text is not exactly that encoding of `bytes`. */
export function decodeB64url(text: string, bytes: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  return raw.length === bytes && raw.toString('base64url') === text ? raw : null;
}

/** The Ed25519 key object for a raw 32-byte public key. */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** `SHA256:` and the unpadded base64 of the SHA-256 of the raw public key (§3). */
export const fingerprintOf = (raw: Uint8Array): string =>
  `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;

/** Whether `sig` (unpadded base64url) is the stored key's Ed25519 signature of `msg`. */
export function verifySignature(msg: Buffer, publicKey: Uint8Array, sig: string): boolean {
  const raw = decodeB64url(sig, 64);
  if (!raw || publicKey.length !== 32) return false;
  try {
    return verify(null, msg, publicKeyFromRaw(publicKey), raw);
  } catch {
    return false;
  }
}

export interface SignedBody {
  connectorId: string;
  ts: number;
  sig: string;
}

/**
 * Checks a signed poll or unpair request against the connector's stored key and this server's
 * origin: the signature must hold and `ts` lie within 120 s of `now`.
 */
export function verifySignedRequest(
  kind: 'poll' | 'unpair',
  body: SignedBody,
  publicKey: Uint8Array,
  origin: string,
  now: Date,
): boolean {
  if (Math.abs(now.getTime() / 1000 - body.ts) > SIGNATURE_WINDOW_SECONDS) return false;
  const build = kind === 'poll' ? pollMessage : unpairMessage;
  return verifySignature(build(body.connectorId, body.ts, origin), publicKey, body.sig);
}
