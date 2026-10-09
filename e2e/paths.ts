import { resolve } from 'node:path';

/** Where the server's file mailer writes during e2e runs (repository-root .local/mail, ADR-0001). */
export const mailDir = resolve(import.meta.dirname, '../.local/mail');
