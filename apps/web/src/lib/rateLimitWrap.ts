import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@marquee/cache";
import { RateLimitError } from "@marquee/core";

interface RateLimitOptions {
  /** Composite key — the helper appends a minute window. */
  key: string;
  limit: number;
  windowSeconds?: number;
}

/**
 * Wraps a route handler with a fixed-window rate limit. The result is
 * accumulated by `key + currentMinute`. On exhaustion the handler is
 * not invoked and a 429 with `Retry-After` is returned.
 */
export function withRateLimit<TArgs extends unknown[]>(
  opts: RateLimitOptions,
  handler: (...args: TArgs) => Promise<NextResponse>,
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args: TArgs) => {
    const minute = Math.floor(Date.now() / 60_000);
    const result = await rateLimit({
      key: `${opts.key}:${minute.toString()}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds ?? 60,
    });
    if (!result.allowed) {
      const err = new RateLimitError(result.resetSeconds);
      return NextResponse.json(
        { error: err.toJSON() },
        { status: 429, headers: { "retry-after": String(result.resetSeconds) } },
      );
    }
    return handler(...args);
  };
}

/**
 * Best-effort client IP for rate-limit keys.
 *
 * `X-Forwarded-For` is client-controlled and trivially spoofable, so it is only
 * honoured when the operator has declared they run behind a trusted reverse
 * proxy (`TRUST_PROXY_HEADERS=1`). The real client IP is then the value the
 * closest trusted proxy appended — the entry `TRUSTED_PROXY_HOPS` (default 1)
 * from the RIGHT, NOT the spoofable leftmost. With no trusted proxy configured
 * we ignore forwarding headers entirely (a single shared bucket is safer than a
 * per-request-spoofable one).
 */
/**
 * Per-tenant+app limiter for endpoints that invoke a paid LLM on every call.
 * Without it an authenticated EDITOR can loop these and run up an unbounded AI
 * bill / exhaust provider quota. Throws RateLimitError (→ 429) when exceeded.
 * `scope` should identify the route + app (e.g. `<tenantId>:<appId>:ai-generate`).
 */
export async function assertAiRateLimit(scope: string, limit = 10): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const result = await rateLimit({
    key: `ai:${scope}:${minute.toString()}`,
    limit,
  });
  if (!result.allowed) throw new RateLimitError(result.resetSeconds);
}

export function clientIp(req: NextRequest): string {
  const trustProxy =
    process.env.TRUST_PROXY_HEADERS === "1" || process.env.TRUST_PROXY_HEADERS === "true";
  if (!trustProxy) return "unknown";

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const hops = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 1);
      const idx = Math.max(0, parts.length - hops);
      const ip = parts[idx];
      if (ip) return ip;
    }
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real && real.length > 0 ? real : "unknown";
}
