import { createHash, randomBytes } from 'node:crypto';

// Secret tokens (sessions, sign-in links, invites). A leaf module, so `db/` can hash and compare
// without importing a feature module.

/** A fresh secret token: 32 random bytes in base64url (43 characters). */
export const newToken = (): string => randomBytes(32).toString('base64url');
/** The shape every token from `newToken` has. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Tokens are stored only as their SHA-256, so a database read cannot be replayed as a cookie. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
