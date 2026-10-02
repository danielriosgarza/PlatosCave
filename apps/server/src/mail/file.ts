import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Mailer, MailMessage } from './mailer';

export interface StoredMail extends MailMessage {
  from: string;
  sentAt: string;
}

/**
 * Writes one JSON file per message. Names sort by send time, and each file appears whole
 * (written aside, then renamed), so a reader taking the newest file never sees half a message.
 */
export class FileMailer implements Mailer {
  private readonly dir: string;

  private sequence = 0;

  constructor(
    dir: string,
    private readonly from: string,
    /** The injected clock (ADR-0006), so file times agree with the rest of the app's. */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = resolve(dir);
  }

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const sentAt = this.now();
    // The clock's time plus a per-process sequence keeps messages sent in one millisecond ordered.
    const seq = String(this.sequence++ % 1e6).padStart(6, '0');
    const name = `${String(sentAt.getTime()).padStart(15, '0')}-${seq}-${randomBytes(4).toString('hex')}.json`;
    const stored: StoredMail = { ...message, from: this.from, sentAt: sentAt.toISOString() };
    const partial = join(this.dir, `.${name}.tmp`);
    await writeFile(partial, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, join(this.dir, name));
  }
}
