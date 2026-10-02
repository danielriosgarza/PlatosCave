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
      // Bounded well under the 10 s stop grace (main.ts), so a hung relay cannot outlive a
      // shutdown's wait for in-flight deliveries (nodemailer defaults: 2 min connect, 10 min socket).
      connectionTimeout: 4_000,
      greetingTimeout: 4_000,
      socketTimeout: 8_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
