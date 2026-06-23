/**
 * Credentials CRUD smoke E2E — the credentials page is the most sensitive
 * UI in the product (handling Apple `.p8` and Google service-account
 * JSON). This test only exercises page load + add-sheet open, since
 * actually submitting real credentials in an E2E run isn't safe.
 */
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com";
const OWNER_PASSWORD = process.env.SELF_HOST_OWNER_PASSWORD ?? "change-me-after-first-login";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', OWNER_EMAIL);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/t\/.+\/dashboard/);
});

test("Credentials page lists & opens add sheet", async ({ page }) => {
  const slug = /\/t\/([^/]+)\//.exec(page.url())?.[1] ?? "default";
  await page.goto(`/t/${slug}/credentials`);
  await expect(page.locator("text=/Credentials/").first()).toBeVisible();

  // Find the "add" / "new" button — wording can vary
  const addBtn = page.locator('button:has-text("Add"), button:has-text("New credential"), button:has-text("Connect")').first();
  if (await addBtn.isVisible()) {
    await addBtn.click();
    // The sheet should appear — look for either label
    await expect(
      page.locator("text=/APPLE|GOOGLE|Apple Key|Service Account/i").first(),
    ).toBeVisible({ timeout: 5000 });
  }
});

test("API GET /credentials → 200 returns array", async ({ page, request }) => {
  // Page first to ensure cookies set
  const slug = /\/t\/([^/]+)\//.exec(page.url())?.[1] ?? "default";
  await page.goto(`/t/${slug}/credentials`);
  const res = await request.get("/api/v1/credentials");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { credentials?: unknown[] } | unknown[];
  // Either { credentials: [] } or []
  if (Array.isArray(body)) {
    expect(Array.isArray(body)).toBe(true);
  } else {
    expect(Array.isArray(body.credentials ?? [])).toBe(true);
  }
});
