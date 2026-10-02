import type { Config } from '../config';
import { FileMailer } from './file';
import { SmtpMailer } from './smtp';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** `file` in development and tests (read by Playwright), `smtp` in production (ADR-0001). */
export function createMailer(config: Config, now: () => Date = () => new Date()): Mailer {
  if (config.MAIL_TRANSPORT === 'smtp') {
    if (!config.SMTP_URL) throw new Error('SMTP_URL is required for MAIL_TRANSPORT=smtp');
    return new SmtpMailer(config.SMTP_URL, config.MAIL_FROM);
  }
  return new FileMailer(config.MAIL_DIR, config.MAIL_FROM, now);
}
