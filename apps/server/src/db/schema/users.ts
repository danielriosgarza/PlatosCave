import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userKind = pgEnum('user_kind', ['user', 'preview']);

/** Identities (ADR-0002). A `preview` user is the shadow principal of one instructor. */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: userKind().notNull().default('user'),
    /** Lower-cased; null only for preview principals. */
    email: text(),
    name: text().notNull(),
    ownerUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    /** Set when the person deactivates the account: no sign-in, no live sessions (§13). */
    deactivatedAt: timestamp({ withTimezone: true }),
    /** Set when the identity was replaced by a pseudonym; the rows it owned stay (plan §8 #23). */
    anonymisedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
    check(
      'users_kind_shape',
      sql`(${t.kind} = 'user' and ${t.email} is not null and ${t.ownerUserId} is null)
        or (${t.kind} = 'preview' and ${t.email} is null and ${t.ownerUserId} is not null)`,
    ),
  ],
);

/** Server-side sessions; the cookie holds a random token, the row only its SHA-256. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    /** When the person last proved control of the account (§3: recent auth for membership changes). */
    authTime: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

/** Single-use, expiring email sign-in links (§3); used by P1-02. */
export const signinTokens = pgTable(
  'signin_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    tokenHash: text().notNull().unique(),
    /** Destination preserved through authentication; validated as same-origin path by P1-02. */
    destination: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  // Keeps the per-address link count cheap; the purge job filters on `expires_at` and relies on
  // the table staying small, so it needs no index.
  (t) => [index('signin_tokens_email_created_idx').on(t.email, t.createdAt)],
);
