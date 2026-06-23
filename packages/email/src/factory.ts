import { ConsoleTransport } from "./ConsoleTransport";
import { SmtpTransport } from "./SmtpTransport";
import type { EmailTransport } from "./Transport";

let _instance: EmailTransport | undefined;

export function createEmailTransport(): EmailTransport {
  if (_instance) return _instance;
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  if (host && portRaw) {
    _instance = new SmtpTransport({
      host,
      port: parseInt(portRaw, 10),
      secure: process.env.SMTP_SECURE === "true",
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      from: process.env.SMTP_FROM ?? "Release Flight <no-reply@releaseflight.com>",
    });
  } else {
    _instance = new ConsoleTransport();
  }
  return _instance;
}

/** Lazy singleton — never throws on import. */
export const emailTransport: EmailTransport = new Proxy({} as EmailTransport, {
  get(_t, prop) {
    const inst = createEmailTransport();
    const value = (inst as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") return value.bind(inst);
    return value;
  },
});
