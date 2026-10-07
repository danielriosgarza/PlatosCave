import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertSafeKey } from '../storage/storage';

/** Content tokens live at most five minutes, so copied links expire (ADR-0002, §13). */
const CONTENT_TOKEN_TTL_S = 300;

/** Clock difference tolerated between the instance that mints and the one that verifies. */
const CLOCK_SKEW_S = 5;

export type Disposition = 'inline' | 'attachment';

/** What a token grants: one object, to one user, minted from one class or course scope. */
export interface ContentGrant {
  key: string;
  userId: string;
  scopeId: string;
  contentType: string;
  disposition: Disposition;
  /** Download file name; only used with `attachment`. */
  filename?: string;
}

export interface ContentClaims extends ContentGrant {
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** `type/subtype` with optional parameters, no line breaks: safe to echo as a header. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;[ -~]*)?$/i;

const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Longest token the content route accepts: the router's `maxParamLength` (app.ts) uses this, and
 * minting refuses anything longer rather than hand out a URL that would answer 414.
 */
export const MAX_TOKEN_LENGTH = 1024;

/** True when the key names an object under the area a course or class id owns (ADR-0002). */
export const keyInScope = (key: string, scopeId: string): boolean =>
  key.startsWith(`courses/${scopeId}/`) || key.startsWith(`classes/${scopeId}/`);

/** Throws unless the key is safe and lies under the scope's own prefix. */
function assertKeyInScope(key: string, scopeId: string): void {
  assertSafeKey(key);
  if (!keyInScope(key, scopeId)) throw new Error(`storage key ${key} is outside scope ${scopeId}`);
}

/** A signed token and its expiry (seconds since the epoch), the one place `exp` is computed. */
export function mintContentToken(
  secret: string,
  grant: ContentGrant,
  now: Date,
): { token: string; exp: number } {
  assertKeyInScope(grant.key, grant.scopeId);
  if (!MEDIA_TYPE.test(grant.contentType)) throw new Error('invalid content type');
  const claims: ContentClaims = {
    ...grant,
    exp: Math.floor(now.getTime() / 1000) + CONTENT_TOKEN_TTL_S,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${payload}.${sign(secret, payload)}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('content token too long');
  return { token, exp: claims.exp };
}

/** The claims of a genuine, unexpired token; null for anything else. */
export function verifyContentToken(secret: string, token: string, now: Date): ContentClaims | null {
  const [payload, mac, ...rest] = token.split('.');
  if (!payload || !mac || rest.length > 0) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: ContentClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // A signed payload that is not an object (null, a number, an array) grants nothing.
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const nowS = now.getTime() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp <= nowS) return null;
  // exp is floored at mint time, so only a minter's clock running ahead pushes it past the TTL.
  if (claims.exp - nowS > CONTENT_TOKEN_TTL_S + CLOCK_SKEW_S) return null;
  try {
    assertKeyInScope(claims.key, claims.scopeId);
  } catch {
    return null;
  }
  if (typeof claims.contentType !== 'string' || !MEDIA_TYPE.test(claims.contentType)) return null;
  return claims;
}
