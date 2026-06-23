import type { EmailMessage } from "../Transport";

export interface InvitationTemplateInput {
  inviterName: string;
  tenantName: string;
  role: string;
  acceptUrl: string;
  expiresInDays: number;
  recipientEmail: string;
  appName?: string;
  /** Optional free-text note written by the inviter, shown inside the email. */
  note?: string;
}

const baseStyle = `
  <style>
    body { background: #FAF8F2; color: #0E0E0C; font-family: -apple-system, system-ui, Segoe UI, sans-serif; padding: 32px; }
    .card { max-width: 480px; margin: auto; background: #FFFFFF; border: 1px solid rgba(14,14,12,0.10); padding: 32px; }
    .mast { font-family: Georgia, "Charter", "Hoefler Text", serif; font-size: 28px; font-style: italic; letter-spacing: -0.02em; }
    .accent { color: #E84B1E; }
    a.btn { display: inline-block; margin-top: 24px; padding: 10px 16px; background: #E84B1E; color: #FFFFFF; text-decoration: none; font-weight: 500; font-size: 13px; letter-spacing: -0.01em; }
    .meta { color: #4A4842; font-size: 12px; margin-top: 16px; }
    code { font-family: ui-monospace, "IBM Plex Mono", Menlo, Consolas, monospace; font-size: 11px; background: #F2EFE8; padding: 2px 4px; }
    hr { border: 0; border-top: 0.5px solid rgba(14,14,12,0.10); margin: 24px 0; }
  </style>
`;

export function renderInvitationEmail(input: InvitationTemplateInput): EmailMessage {
  const subject = `${input.inviterName} invited you to ${input.tenantName} on Release Flight`;
  const text = [
    `Hello,`,
    ``,
    `${input.inviterName} has invited you to join the "${input.tenantName}" workspace on Release Flight as ${input.role}.`,
    ``,
    ...(input.note ? [`Note from ${input.inviterName}: ${input.note}`, ``] : []),
    `Accept the invitation:`,
    input.acceptUrl,
    ``,
    `The invitation expires in ${input.expiresInDays.toString()} days.`,
    ``,
    `— Release Flight`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${baseStyle}</head><body>
  <div class="card">
    <p class="mast">Game<span class="accent">Publisher</span></p>
    <p>Hello,</p>
    <p><strong>${escapeHtml(input.inviterName)}</strong> has invited you to join the <strong>${escapeHtml(input.tenantName)}</strong> workspace as <code>${escapeHtml(input.role)}</code>.</p>
    ${input.note ? `<p class="meta" style="background:#F2EFE8;padding:12px;border-left:2px solid #E84B1E;">${escapeHtml(input.note)}</p>` : ""}
    <p><a class="btn" href="${escapeAttr(input.acceptUrl)}">→  Accept invitation</a></p>
    <hr />
    <p class="meta">This invitation expires in ${input.expiresInDays.toString()} days. If the button doesn't work, copy and paste this URL:<br />
    <code>${escapeHtml(input.acceptUrl)}</code></p>
    <p class="meta">You can ignore this email if it wasn't intended for you (${escapeHtml(input.recipientEmail)}).</p>
  </div>
</body></html>`;

  return { to: input.recipientEmail, subject, text, html, tag: "invitation" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
