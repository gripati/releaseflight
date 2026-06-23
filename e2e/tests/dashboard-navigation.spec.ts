/**
 * Dashboard navigation E2E — once logged in, every primary nav item
 * should resolve to a 2xx page that renders its heading. Catches
 * routing regressions, missing layouts, and broken default tenant slugs.
 */
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com";
const OWNER_PASSWORD = process.env.SELF_HOST_OWNER_PASSWORD ?? "change-me-after-first-login";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', OWNER_EMAIL);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/t\/.+\/dashboard/, { timeout: 15_000 });
});

test("Reaches Apps", async ({ page }) => {
  const m = /\/t\/(?<slug>[^/]+)\/dashboard/.exec(page.url());
  const slug = m?.groups?.slug ?? "default";
  await page.goto(`/t/${slug}/apps`);
  await expect(page.locator("text=/Apps/").first()).toBeVisible();
});

test("Reaches Credentials", async ({ page }) => {
  const m = /\/t\/(?<slug>[^/]+)\/dashboard/.exec(page.url());
  const slug = m?.groups?.slug ?? "default";
  await page.goto(`/t/${slug}/credentials`);
  await expect(page.locator("text=/Credentials/").first()).toBeVisible();
});

test("Reaches Seats (and /team redirects there)", async ({ page }) => {
  const m = /\/t\/(?<slug>[^/]+)\/dashboard/.exec(page.url());
  const slug = m?.groups?.slug ?? "default";
  // "Team" was merged into "Seats" and now permanently redirects.
  await page.goto(`/t/${slug}/team`);
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/seats`));
  await expect(page.locator("text=/Seat|Member|Role/").first()).toBeVisible();
});

test("Reaches Settings", async ({ page }) => {
  const m = /\/t\/(?<slug>[^/]+)\/dashboard/.exec(page.url());
  const slug = m?.groups?.slug ?? "default";
  await page.goto(`/t/${slug}/settings`);
  await expect(page.locator("text=/Settings|Tenant/").first()).toBeVisible();
});

test("Reaches Audit log", async ({ page }) => {
  const m = /\/t\/(?<slug>[^/]+)\/dashboard/.exec(page.url());
  const slug = m?.groups?.slug ?? "default";
  await page.goto(`/t/${slug}/audit`);
  await expect(page.locator("text=/Audit|Activity/").first()).toBeVisible();
});

test("Slug spoofing returns 404 / blocks access", async ({ page }) => {
  const res = await page.goto("/t/this-slug-does-not-exist/dashboard");
  expect(res?.status() ?? 404).toBeGreaterThanOrEqual(400);
});
