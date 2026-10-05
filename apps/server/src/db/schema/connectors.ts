import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { classes } from './memberships';
import { users } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const connectorMode = pgEnum('connector_mode', ['personal', 'managed']);
export const connectorStatus = pgEnum('connector_status', ['pending', 'active', 'revoked']);
export const connectorRevokedReason = pgEnum('connector_revoked_reason', [
  'user',
  'unpair',
  'account',
  'expired',
  'rejected',
]);
export const computeIsolation = pgEnum('compute_isolation', ['account', 'container', 'allocation']);

/**
 * A paired compute connector (docs/design/connector.md §3, §10.2). User-owned, not class data:
 * a personal connector belongs to one person across classes, a managed one (P3-05b) to nobody.
 * Only the Ed25519 public key is stored; the connector proves itself by signing (§4.2).
 */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Null exactly for a managed connector. */
    ownerUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    mode: connectorMode().notNull(),
    status: connectorStatus().notNull(),
    publicKey: bytea().notNull(),
    fingerprint: text().notNull().unique(),
    os: text().notNull(),
    arch: text().notNull(),
    version: text().notNull(),
    /** What the connector reported in `hello` (§8): `{ cidrs, hosts }`. */
    networkScope: jsonb()
      .$type<{ cidrs: string[]; hosts: string[] }>()
      .notNull()
      .default({ cidrs: [], hosts: [] }),
    /** A pending connector not approved by then is expired. */
    approveBy: timestamp({ withTimezone: true }),
    approvedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    revokedReason: connectorRevokedReason(),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.ownerUserId, t.status),
    check('connectors_owner_mode', sql`(${t.mode} = 'personal') = (${t.ownerUserId} is not null)`),
    check('connectors_name_length', sql`char_length(${t.name}) between 1 and 60`),
    check('connectors_public_key_length', sql`octet_length(${t.publicKey}) = 32`),
    check('connectors_pending', sql`(${t.status} = 'pending') = (${t.approveBy} is not null)`),
    check('connectors_revoked', sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
    check(
      'connectors_revoked_reason',
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null)`,
    ),
    check(
      'connectors_approved',
      sql`(${t.status} <> 'active' or ${t.approvedAt} is not null)
        and (${t.status} <> 'pending' or ${t.approvedAt} is null)`,
    ),
  ],
);

/**
 * Single-use pairing codes (§3). Only `HMAC-SHA256(K, code)` is stored, with K derived from
 * SESSION_SECRET; used and expired rows are purged by the maintenance job.
 */
export const connectorPairings = pgTable(
  'connector_pairings',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: bytea().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    connectorId: uuid().references(() => connectors.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.ownerUserId, t.expiresAt)],
);

export interface TrustedHostKey {
  host: string;
  port: number;
  sha256: string;
  confirmedAt: string;
}

/**
 * Class compute templates (P3-10): a host, runtime and isolation an instructor publishes for a
 * class. A template carries no user and no authentication.
 */
export const classComputeTemplates = pgTable(
  'class_compute_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    classId: uuid()
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull(),
    target: jsonb().notNull(),
    runtime: jsonb().notNull(),
    isolation: computeIsolation().notNull(),
    lease: jsonb(),
    hostOwnerConfirmedBy: uuid()
      .notNull()
      .references(() => users.id),
    hostOwnerConfirmedAt: timestamp({ withTimezone: true }).notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.classId)],
);

/**
 * A person's saved, secret-free reference to a target (P3-06): host, user, workspace, runtime
 * and the host keys they confirmed. User-owned across classes.
 */
export const notebookConnections = pgTable(
  'notebook_connections',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    target: jsonb().notNull(),
    runtime: jsonb().notNull(),
    templateId: uuid().references((): AnyPgColumn => classComputeTemplates.id),
    trustedHostKeys: jsonb().$type<TrustedHostKey[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('notebook_connections_owner_name_key')
      .on(t.ownerUserId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index().on(t.connectorId),
    check('notebook_connections_name_length', sql`char_length(${t.name}) between 1 and 60`),
  ],
);
