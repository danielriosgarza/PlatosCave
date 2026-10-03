import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './mailer';

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      url,
      // Per phase, not per send: the socket timeout is an inactivity timeout that restarts on
      // every byte, so a relay answering slowly through EHLO, STARTTLS, AUTH, MAIL, RCPT and DATA
      // can take several times these. They only stop a dead connection early (nodemailer defaults:
      // 2 min connect, 10 min socket); the bound on a whole delivery is DELIVERY_TIMEOUT_MS in
      // auth/email-provider.ts.
      connectionTimeout: 4_000,
      greetingTimeout: 4_000,
      socketTimeout: 8_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
