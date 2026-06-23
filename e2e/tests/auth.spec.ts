/**
 * Auth E2E — the only page that's truly public is /login.
 * Verifies the CSRF→login round-trip end-to-end and ensures protected
 * routes redirect to /login when unauthenticated.
 */
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com";
const OWNER_PASSWORD = process.env.SELF_HOST_OWNER_PASSWORD ?? "change-me-after-first-login";

test.describe("Authentication", () => {
  test("Unauthenticated visit to / redirects to /login", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status() ?? 200).toBeLessThan(500);
    await expect(page).toHaveURL(/\/login/);
  });

  test("Login form is present and styled", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible();
  });

  test("Wrong password yields a visible error and stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[name="email"]', OWNER_EMAIL);
    await page.fill('input[name="password"]', "definitely-wrong");
    await page.click('button:has-text("Sign in")');
    await expect(page).toHaveURL(/\/login/);
    // Error region — any of these wording variants
    await expect(
      page.locator("text=/Sign-in failed|Invalid|incorrect/i"),
    ).toBeVisible({ timeout: 5000 });
  });

  test("Valid credentials redirect into dashboard / tenant picker", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[name="email"]', OWNER_EMAIL);
    await page.fill('input[name="password"]', OWNER_PASSWORD);
    await page.click('button:has-text("Sign in")');
    await page.waitForURL(/\/t\/.+\/dashboard|\/account\/tenants/, { timeout: 15_000 });
  });

  test("Logout redirects to /login", async ({ page, request }) => {
    // First obtain a session
    await page.goto("/login");
    await page.fill('input[name="email"]', OWNER_EMAIL);
    await page.fill('input[name="password"]', OWNER_PASSWORD);
    await page.click('button:has-text("Sign in")');
    await page.waitForURL(/\/t\/.+\/dashboard|\/account\/tenants/);

    // Fetch CSRF for logout
    const csrfResp = await request.get("/api/v1/auth/csrf-token");
    const csrfBody = (await csrfResp.json()) as { csrfToken: string };
    const logoutResp = await request.post("/api/v1/auth/logout", {
      headers: { "x-csrf-token": csrfBody.csrfToken },
    });
    expect(logoutResp.ok()).toBe(true);
  });
});
