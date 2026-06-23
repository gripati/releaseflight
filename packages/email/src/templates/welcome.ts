import type { EmailMessage } from "../Transport";

export function renderWelcomeEmail(input: { recipientEmail: string; displayName: string; appUrl: string }): EmailMessage {
  const subject = `Welcome to Release Flight`;
  const text = [
    `Hi ${input.displayName},`,
    ``,
    `Your workspace is ready. Sign in:`,
    input.appUrl,
    ``,
    `— Release Flight`,
  ].join("\n");
  const html = `<p>Hi ${input.displayName.replace(/</g, "&lt;")},</p><p>Your workspace is ready. <a href="${input.appUrl}">Sign in →</a></p>`;
  return { to: input.recipientEmail, subject, text, html, tag: "welcome" };
}
