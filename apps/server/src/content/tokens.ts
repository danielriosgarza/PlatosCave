import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertSafeKey } from '../storage/storage';

/** Content tokens live at most five minutes, so copied links expire (ADR-0002, §13). */
export const CONTENT_TOKEN_TTL_S = 300;

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

/** Throws unless the key names an object under the scope's own prefix (ADR-0002). */
export function assertKeyInScope(key: string, scopeId: string): void {
  assertSafeKey(key);
  if (!key.startsWith(`courses/${scopeId}/`) && !key.startsWith(`classes/${scopeId}/`)) {
    throw new Error(`storage key ${key} is outside scope ${scopeId}`);
  }
}

export function mintContentToken(secret: string, grant: ContentGrant, now: Date): string {
  assertKeyInScope(grant.key, grant.scopeId);
  if (!MEDIA_TYPE.test(grant.contentType)) throw new Error('invalid content type');
  const claims: ContentClaims = {
    ...grant,
    exp: Math.floor(now.getTime() / 1000) + CONTENT_TOKEN_TTL_S,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
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
  const nowS = now.getTime() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp <= nowS) return null;
  if (claims.exp - nowS > CONTENT_TOKEN_TTL_S) return null;
  try {
    assertKeyInScope(claims.key, claims.scopeId);
  } catch {
    return null;
  }
  if (typeof claims.contentType !== 'string' || !MEDIA_TYPE.test(claims.contentType)) return null;
  return claims;
}
