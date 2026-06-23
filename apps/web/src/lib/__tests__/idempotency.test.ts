/**
 * Idempotency-key middleware test — verifies that:
 *   1. Without a key the handler runs normally.
 *   2. With a key the first request runs, the second is replayed from cache.
 *   3. Cache keys are tenant-scoped — same key across two tenants does NOT
 *      collide.
 *   4. Replayed responses carry `x-idempotency-replay: true`.
 *   5. Keys longer than 128 chars are ignored (handler runs normally).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const store = new Map<string, string>();

vi.mock("@marquee/cache", () => ({
  redis: {
    get: async (k: string): Promise<string | null> => store.get(k) ?? null,
    set: async (k: string, v: string): Promise<"OK"> => {
      store.set(k, v);
      return "OK";
    },
  },
}));

let tenantId: string | undefined = "tenant-a";
vi.mock("@marquee/db", () => ({
  getTenantContext: (): { tenantId: string } | undefined =>
    tenantId === undefined ? undefined : { tenantId },
}));

import { withIdempotency } from "../idempotency";

beforeEach(() => {
  store.clear();
  tenantId = "tenant-a";
});

function mkReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/x", {
    method: "POST",
    headers,
  });
}

describe("withIdempotency", () => {
  test("passes through when no key is set", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({ ok: true });
    });
    const r1 = await handler(mkReq());
    const r2 = await handler(mkReq());
    expect(calls).toBe(2);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("returns cached response on replay with same key", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({ jobId: `j${calls.toString()}` }, { status: 201 });
    });

    const first = await handler(mkReq({ "idempotency-key": "abc-123" }));
    const replay = await handler(mkReq({ "idempotency-key": "abc-123" }));

    expect(calls).toBe(1);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-idempotency-replay")).toBe("true");
    const firstBody = (await first.json()) as { jobId: string };
    const replayBody = (await replay.json()) as { jobId: string };
    expect(replayBody.jobId).toBe(firstBody.jobId);
  });

  test("tenant-scopes cache keys — same key, different tenant does NOT replay", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({ tenantCall: calls }, { status: 200 });
    });

    tenantId = "tenant-a";
    await handler(mkReq({ "idempotency-key": "shared" }));
    tenantId = "tenant-b";
    await handler(mkReq({ "idempotency-key": "shared" }));

    expect(calls).toBe(2);
    // Keys are `idem:<tenant>:<key>:<method+path+body fingerprint>`.
    const keys = Array.from(store.keys()).sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^idem:tenant-a:shared:[a-f0-9]{64}$/);
    expect(keys[1]).toMatch(/^idem:tenant-b:shared:[a-f0-9]{64}$/);
  });

  test("same key but a different body does NOT replay (key is body-bound)", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({ n: calls }, { status: 200 });
    });
    const mk = (body: unknown): NextRequest =>
      new NextRequest("http://localhost/api/v1/x", {
        method: "POST",
        headers: { "idempotency-key": "k" },
        body: JSON.stringify(body),
      });
    await handler(mk({ a: 1 }));
    await handler(mk({ a: 2 }));
    expect(calls).toBe(2);
  });

  test("does not cache non-2xx responses", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({ err: true }, { status: 500 });
    });
    await handler(mkReq({ "idempotency-key": "errkey" }));
    await handler(mkReq({ "idempotency-key": "errkey" }));
    expect(calls).toBe(2); // error was not replayed
    expect(store.size).toBe(0); // nothing cached
  });

  test("ignores oversized idempotency keys (> 128 chars)", async () => {
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({}, { status: 200 });
    });
    const huge = "x".repeat(200);
    await handler(mkReq({ "idempotency-key": huge }));
    await handler(mkReq({ "idempotency-key": huge }));
    expect(calls).toBe(2);
    expect(store.size).toBe(0);
  });

  test("falls back to anon scope when tenant context is absent", async () => {
    tenantId = undefined;
    let calls = 0;
    const handler = withIdempotency(async () => {
      calls += 1;
      return NextResponse.json({}, { status: 200 });
    });
    await handler(mkReq({ "idempotency-key": "anon-key" }));
    await handler(mkReq({ "idempotency-key": "anon-key" }));
    expect(calls).toBe(1);
    const keys = Array.from(store.keys());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^idem:anon:anon-key:[a-f0-9]{64}$/);
  });
});
