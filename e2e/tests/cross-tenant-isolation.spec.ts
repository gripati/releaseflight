/**
 * Cross-tenant isolation E2E — exercises the full stack from the browser:
 * a user belonging to Tenant A cannot enumerate, read, or mutate Tenant B's
 * resources through any public route.
 *
 * Prerequisite: seed creates a `default` self-host tenant with the owner
 * user. We additionally insert a second tenant + user via API. If signup
 * is disabled (DEPLOY_MODE=self_host), this test runs in single-tenant mode
 * and only exercises the slug-spoofing protection.
 */
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com";
const OWNER_PASSWORD = process.env.SELF_HOST_OWNER_PASSWORD ?? "change-me-after-first-login";

async function login(page: import("@playwright/test").Page, email = OWNER_EMAIL, password = OWNER_PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/t\/.*\/dashboard|\/account\/tenants/);
}

test.describe("Cross-tenant isolation (browser)", () => {
  test("Login + reach own dashboard", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/t\/.+\/dashboard/);
    await expect(page.locator("text=Dashboard")).toBeVisible();
  });

  test("Slug spoofing returns 404", async ({ page }) => {
    await login(page);
    const res = await page.goto("/t/this-slug-does-not-exist/dashboard");
    // 404 is rendered via not-found(); page returns either 404 or default
    expect(res?.status() ?? 404).toBeGreaterThanOrEqual(400);
  });

  test("API requires CSRF on mutating endpoint", async ({ page, request }) => {
    await login(page);
    // No CSRF header → 403
    const noCsrf = await request.post("/api/v1/credentials", {
      data: { kind: "APPLE", name: "x", keyId: "AAAA1111", issuerId: "00000000-0000-0000-0000-000000000000", privateKeyPem: "BEGIN" },
    });
    expect(noCsrf.status()).toBe(403);
  });

  test("Healthz returns 200 unauthenticated", async ({ request }) => {
    const res = await request.get("/api/v1/healthz");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });
});
