import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const auditScopeKind = pgEnum('audit_scope_kind', ['user', 'class', 'course', 'system']);

/** Append-only history of membership, grant, publication, submission and export changes (§13). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Null for system actions (fixtures, jobs without a person). */
    actorId: uuid().references(() => users.id),
    action: text().notNull(),
    scopeKind: auditScopeKind().notNull(),
    scopeId: uuid(),
    targetType: text().notNull(),
    targetId: uuid(),
    before: jsonb(),
    after: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.scopeKind, t.scopeId, t.createdAt)],
);
