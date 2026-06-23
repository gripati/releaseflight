import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailTransport } from "./Transport";

export interface SmtpOptions {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
}

/**
 * SMTP transport. Works against Mailhog locally (port 1025) and any
 * production provider (Postmark, SES, Resend SMTP, SendGrid, …).
 */
export class SmtpTransport implements EmailTransport {
  private readonly transporter: Transporter;
  constructor(private readonly opts: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure ?? false,
      ...(opts.user && opts.password ? { auth: { user: opts.user, pass: opts.password } } : {}),
    });
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const info = await this.transporter.sendMail({
      from: this.opts.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.tag ? { "X-Tag": message.tag } : undefined,
    });
    return { id: info.messageId };
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
