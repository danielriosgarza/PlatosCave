import { resolve } from 'node:path';

/** Where the server's file mailer writes during e2e runs (repository-root .local/mail, ADR-0001). */
export const mailDir = resolve(import.meta.dirname, '../.local/mail');

/** The READY_PROBE_TOKEN the e2e server starts with; a probe sends it as X-Ready-Token. */
export const E2E_PROBE_TOKEN = 'e2e-probe-token-0123456789';
