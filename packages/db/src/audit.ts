/**
 * Tenant-scoped audit logger. Auto-fills tenantId + userId from the
 * AsyncLocalStorage context. Sensitive fields in `diff` should be
 * pre-redacted by the caller (only field NAMES are tracked, not raw
 * private keys / passwords).
 */
import type { AuditOutcome } from "@prisma/client";
import { type Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getTenantContext } from "./tenantContext";

export interface RecordAuditInput {
  action: string;
  target?: string | undefined;
  diff?: Prisma.InputJsonValue | undefined;
  outcome: AuditOutcome;
  errorCode?: string | undefined;
  appId?: string | undefined;
  requestId?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

const SENSITIVE_FIELDS = new Set([
  "password",
  "passwordHash",
  "privateKey",
  "privateKeyPem",
  "private_key",
  "serviceAccountJson",
  "secretRef",
  "token",
  "totpSecret",
]);

/** Strips obvious secret fields from any diff object before storing. */
function redactDiff(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactDiff);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(k)) out[k] = "<REDACTED>";
    else out[k] = redactDiff(v);
  }
  return out;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const ctx = getTenantContext();
  if (!ctx) return; // best-effort — never throw from audit
  try {
    await prisma.auditEvent.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        appId: input.appId ?? null,
        action: input.action,
        target: input.target ?? null,
        diff: (input.diff !== undefined
          ? redactDiff(input.diff)
          : undefined) as Prisma.InputJsonValue,
        outcome: input.outcome,
        errorCode: input.errorCode ?? null,
        requestId: input.requestId ?? ctx.requestId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch {
    /* swallow — audit failure must never break the user request */
  }
}
