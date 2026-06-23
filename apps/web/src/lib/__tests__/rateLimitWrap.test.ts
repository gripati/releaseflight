/**
 * Rate-limit wrapper test — runs the real handler under a faked
 * `rateLimit` helper to verify the wrap:
 *   1. Forwards args when under the limit.
 *   2. Returns 429 + Retry-After header once exceeded.
 *   3. Does not invoke the inner handler when blocked.
 *   4. Builds the bucket key with the current minute appended.
 *   5. clientIp extracts XFF / x-real-ip / "unknown".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const rateLimitFn = vi.fn();
vi.mock("@marquee/cache", () => ({
  rateLimit: (opts: unknown) => rateLimitFn(opts),
}));

import { assertAiRateLimit, clientIp, withRateLimit } from "../rateLimitWrap";

beforeEach(() => {
  rateLimitFn.mockReset();
});

describe("withRateLimit", () => {
  test("forwards call when under the limit", async () => {
    rateLimitFn.mockResolvedValue({ allowed: true, remaining: 9, resetSeconds: 60, limit: 10 });
    const inner = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withRateLimit({ key: "x", limit: 10 }, inner);
    const res = await wrapped("arg");
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledWith("arg");
  });

  test("returns 429 with Retry-After when exceeded", async () => {
    rateLimitFn.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 42, limit: 10 });
    const inner = vi.fn();
    const wrapped = withRateLimit({ key: "x", limit: 10 }, inner);
    const res = await wrapped();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(inner).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  test("appends a minute window to the bucket key", async () => {
    rateLimitFn.mockResolvedValue({ allowed: true, remaining: 1, resetSeconds: 60, limit: 1 });
    const wrapped = withRateLimit({ key: "login:foo", limit: 1 }, async () => NextResponse.json({}));
    await wrapped();
    const call = rateLimitFn.mock.calls[0]?.[0] as { key: string };
    expect(call.key).toMatch(/^login:foo:\d+$/);
  });
});

describe("assertAiRateLimit (MARQ-015/018)", () => {
  test("resolves when under the limit and keys on ai:<scope>:<minute>", async () => {
    rateLimitFn.mockResolvedValue({ allowed: true, remaining: 9, resetSeconds: 60, limit: 10 });
    await expect(assertAiRateLimit("t1:app1:ai-generate")).resolves.toBeUndefined();
    const call = rateLimitFn.mock.calls[0]?.[0] as { key: string; limit: number };
    expect(call.key).toMatch(/^ai:t1:app1:ai-generate:\d+$/);
    expect(call.limit).toBe(10);
  });

  test("throws RateLimitError when the AI budget is exhausted", async () => {
    rateLimitFn.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 30, limit: 10 });
    await expect(assertAiRateLimit("t1:app1:ai-generate")).rejects.toThrow();
  });
});

describe("clientIp", () => {
  const ORIG = process.env.TRUST_PROXY_HEADERS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = ORIG;
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  test("ignores spoofable XFF when no trusted proxy is configured", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const req = new NextRequest("http://localhost/x", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("unknown");
  });

  test("with a trusted proxy, uses the rightmost (proxy-appended) XFF entry", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    const req = new NextRequest("http://localhost/x", {
      // The leftmost value is client-spoofable; the proxy appends the real
      // client as the last entry (default 1 hop).
      headers: { "x-forwarded-for": "203.0.113.5, 198.51.100.7" },
    });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  test("with a trusted proxy, falls back to x-real-ip when no XFF", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    const req = new NextRequest("http://localhost/x", { headers: { "x-real-ip": "198.51.100.7" } });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  test("returns 'unknown' when no client ip header is present", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    const req = new NextRequest("http://localhost/x");
    expect(clientIp(req)).toBe("unknown");
  });
});
