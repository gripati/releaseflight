import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { redis } from "@marquee/cache";
import { getTenantContext } from "@marquee/db";

const TTL_SECONDS = 24 * 60 * 60;
const HEADER = "idempotency-key";
const MAX_KEY_LEN = 128;
const KEY_RE = /^[A-Za-z0-9._:-]+$/;

interface CachedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  storedAt: string;
}

function isValidKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LEN && KEY_RE.test(key);
}

/**
 * Idempotency middleware for mutating endpoints. The client sends an
 * `Idempotency-Key` header (UUID recommended) and we cache the full
 * response for 24 hours.
 *
 * The cache identity is bound to the tenant AND a fingerprint of
 * method + path + body, so re-using one key for a DIFFERENT mutation cannot
 * replay the first response (the prior key-only cache silently swallowed the
 * second write). Only successful (2xx) responses are cached — a transient
 * 4xx/5xx must not be pinned for 24h. The key format is validated.
 */
export function withIdempotency<TRest extends unknown[]>(
  handler: (req: NextRequest, ...rest: TRest) => Promise<NextResponse>,
): (req: NextRequest, ...rest: TRest) => Promise<NextResponse> {
  return async (req: NextRequest, ...rest: TRest) => {
    const key = req.headers.get(HEADER);
    if (!key || !isValidKey(key)) {
      // No (or malformed) key → run normally.
      return handler(req, ...rest);
    }
    const tenantId = getTenantContext()?.tenantId ?? "anon";
    const bodyText = await req
      .clone()
      .text()
      .catch(() => "");
    const fingerprint = createHash("sha256")
      .update(`${req.method}\n${new URL(req.url).pathname}\n${bodyText}`)
      .digest("hex");
    const cacheKey = `idem:${tenantId}:${key}:${fingerprint}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached) as CachedResponse;
      return new NextResponse(JSON.stringify(data.body), {
        status: data.status,
        headers: { ...data.headers, "x-idempotency-replay": "true" },
      });
    }

    const res = await handler(req, ...rest);
    // Cache successes only — never pin an error response.
    if (res.status >= 200 && res.status < 300) {
      const body = await res.clone().text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const stored: CachedResponse = {
        status: res.status,
        body: body ? JSON.parse(body) : null,
        headers,
        storedAt: new Date().toISOString(),
      };
      await redis.set(cacheKey, JSON.stringify(stored), "EX", TTL_SECONDS);
    }
    return res;
  };
}
