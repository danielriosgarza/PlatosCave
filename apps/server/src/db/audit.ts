import type { Tx } from './client';
import { auditEvents } from './schema';

export type AuditEvent = typeof auditEvents.$inferInsert;

/**
 * Appends audit events (ADR-0002) inside the transaction making the change; several in one
 * statement when given a non-empty array. The only writer of `audit_events`: a leaf module, so
 * domain modules import it without importing each other.
 */
export const audit = (tx: Tx, event: AuditEvent | AuditEvent[]) =>
  tx.insert(auditEvents).values(Array.isArray(event) ? event : [event]);
