/**
 * withObservability test — confirms that:
 *   - The histogram + counter are incremented exactly once per call.
 *   - On thrown error we still observe with status=500, then re-throw.
 *   - The original status from a NextResponse is propagated to metrics.
 */
import { describe, expect, test, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const seen: { method: string; route: string; status: number; seconds: number }[] = [];
vi.mock("@marquee/observability", () => ({
  observeHttp: (method: string, route: string, status: number, seconds: number): void => {
    seen.push({ method, route, status, seconds });
  },
}));

import { withObservability } from "../observe";

describe("withObservability", () => {
  test("emits the request status + a non-negative duration", async () => {
    seen.length = 0;
    const wrapped = withObservability("/api/v1/x", async () => NextResponse.json({ ok: true }, { status: 200 }));
    const res = await wrapped(new NextRequest("http://localhost/x", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", route: "/api/v1/x", status: 200 });
    expect(seen[0]?.seconds).toBeGreaterThanOrEqual(0);
  });

  test("on throw, observes status=500 then re-throws", async () => {
    seen.length = 0;
    const wrapped = withObservability("/api/v1/boom", async () => {
      throw new Error("kaboom");
    });
    await expect(
      wrapped(new NextRequest("http://localhost/x", { method: "POST" })),
    ).rejects.toThrow("kaboom");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(500);
    expect(seen[0]?.method).toBe("POST");
  });
});
