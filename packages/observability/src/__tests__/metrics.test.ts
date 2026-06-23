import { describe, expect, test } from "vitest";
import {
  httpRequests,
  metricsHandler,
  observeHttp,
  observeJob,
  registry,
} from "../index";

describe("metrics registry", () => {
  test("exports Prometheus exposition format", async () => {
    observeHttp("GET", "/api/v1/healthz", 200, 0.002);
    const out = await metricsHandler();
    expect(out.contentType).toContain("text/plain");
    expect(out.body).toContain("gp_http_requests_total");
    expect(out.body).toContain('method="GET"');
    expect(out.body).toContain('route="/api/v1/healthz"');
  });

  test("status label encodes raw code", () => {
    httpRequests.reset();
    observeHttp("POST", "/api/v1/auth/login", 401, 0.01);
    observeHttp("POST", "/api/v1/auth/login", 200, 0.01);
    const labels = (
      httpRequests as unknown as { hashMap: Record<string, { labels: { status: string } }> }
    ).hashMap;
    const codes = new Set(Object.values(labels).map((v) => v.labels.status));
    expect(codes.has("401")).toBe(true);
    expect(codes.has("200")).toBe(true);
  });

  test("observeJob increments completed on success, failed on throw", async () => {
    const out1 = await observeJob("test.queue", async () => 42);
    expect(out1).toBe(42);
    await expect(
      observeJob("test.queue", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const body = await registry.metrics();
    expect(body).toMatch(/gp_jobs_total\{queue="test.queue",status="completed"\} \d+/);
    expect(body).toMatch(/gp_jobs_total\{queue="test.queue",status="failed"\} \d+/);
  });
});
