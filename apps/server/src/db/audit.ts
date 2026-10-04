import type { Tx } from './client';
import { auditEvents } from './schema';

export type AuditEvent = typeof auditEvents.$inferInsert;

/**
 * Appends one audit event (ADR-0002) inside the transaction making the change. The only writer
 * of `audit_events`: a leaf module, so domain modules import it without importing each other.
 */
export const audit = (tx: Tx, event: AuditEvent) => tx.insert(auditEvents).values(event);
