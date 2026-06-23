import { NextResponse } from "next/server";
import { AppError } from "@marquee/core";
import { ZodError } from "zod";
import { logger } from "./logger";
import { captureError } from "./errorReporting";
import { assertBillingActive } from "./seats";

export function jsonError(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Paths that MUST keep working while a subscription is on hold, so the buyer can
// log in and recover: auth (login/logout/password), license activation, and the
// billing-fix flow. Everything else mutating is frozen read-only when suspended.
const FREEZE_EXEMPT_PREFIXES = ["/api/v1/auth/", "/api/v1/license/", "/api/v1/billing/"];

/**
 * Read-only freeze: when the subscription is suspended (past grace / revoked),
 * block every MUTATING `/api/v1` request except the recovery paths above. Reads
 * (GET/HEAD) are never touched, so the buyer keeps full visibility + export.
 * A complete no-op unless a Polar-driven token reports `billingState=suspended`.
 */
function enforceReadOnlyFreeze(req: unknown): void {
  const r = req as { method?: unknown; nextUrl?: { pathname?: unknown } } | undefined;
  if (!r || typeof r.method !== "string" || !MUTATING_METHODS.has(r.method)) return;
  const path = typeof r.nextUrl?.pathname === "string" ? r.nextUrl.pathname : "";
  if (!path || FREEZE_EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return;
  assertBillingActive();
}

/**
 * Wraps a route handler with consistent error handling — converts
 * AppError / ZodError into shaped JSON responses, logs unknowns. Also applies
 * the billing read-only freeze to mutating requests (§ seats.ts).
 */
export function withApiErrors<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<NextResponse>,
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args: TArgs) => {
    try {
      enforceReadOnlyFreeze(args[0]);
      return await handler(...args);
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        return jsonError(400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request",
            details: { issues: err.issues },
          },
        });
      }
      if (err instanceof AppError) {
        return jsonError(err.httpStatus, { error: err.toJSON() });
      }
      logger.error({ err }, "Unhandled error in route handler");
      captureError(err, { layer: "api" });
      return jsonError(500, {
        error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
      });
    }
  };
}
