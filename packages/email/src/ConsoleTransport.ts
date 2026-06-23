import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailTransport } from "./Transport";

/**
 * Development email transport. Writes the rendered subject + text to
 * stdout so the user can copy the verification / invitation URL from
 * `pnpm dev` logs without setting up SMTP. Never used in production.
 */
export class ConsoleTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<{ id: string }> {
    const id = randomUUID();
    const to = Array.isArray(message.to) ? message.to.join(", ") : message.to;

    console.log(
      [
        "",
        "── ✉️  email (console transport) ─────────────────────────────────────",
        `To:      ${to}`,
        `Subject: ${message.subject}`,
        message.tag ? `Tag:     ${message.tag}` : "",
        "Body:",
        message.text,
        "─────────────────────────────────────────────────────────────────────",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { id };
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
