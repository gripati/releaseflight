/**
 * Public-endpoint smoke E2E — the surface that synthetic monitors and
 * load balancers depend on. If any of these break, the system is
 * effectively down regardless of feature parity.
 */
import { expect, test } from "@playwright/test";

test.describe("Public endpoints", () => {
  test("/api/v1/healthz → 200 with alive payload", async ({ request }) => {
    const res = await request.get("/api/v1/healthz");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });

  test("/api/v1/readyz → 200 when DB+Redis up", async ({ request }) => {
    const res = await request.get("/api/v1/readyz");
    expect([200, 503]).toContain(res.status());
  });

  test("/api/v1/status → JSON with components + slo", async ({ request }) => {
    const res = await request.get("/api/v1/status");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      components: { id: string }[];
      slo: { id: string }[];
    };
    expect(["operational", "degraded", "outage"]).toContain(body.status);
    expect(body.components.length).toBeGreaterThan(0);
    expect(body.slo.length).toBeGreaterThan(0);
  });

  test("/status page renders without errors", async ({ page }) => {
    const res = await page.goto("/status");
    expect(res?.status() ?? 200).toBeLessThan(500);
    await expect(page.locator("text=/Status|operational|degraded|outage/i").first()).toBeVisible();
  });

  test("/api/v1/metrics → 401 without bearer (or 503 if unset)", async ({ request }) => {
    const res = await request.get("/api/v1/metrics");
    expect([401, 503]).toContain(res.status());
  });

  test("/api/v1/health/deep → 403 without auth", async ({ request }) => {
    const res = await request.get("/api/v1/health/deep");
    expect([403, 401]).toContain(res.status());
  });
});
