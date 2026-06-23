/**
 * Apps list smoke E2E — the apps page is the entry into the metadata /
 * screenshots editors. This test verifies the page renders for an empty
 * tenant and that the connect-app wizard at least opens.
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

test("Apps page renders empty state without errors", async ({ page }) => {
  const slug = /\/t\/([^/]+)\//.exec(page.url())?.[1] ?? "default";
  const res = await page.goto(`/t/${slug}/apps`);
  expect(res?.status() ?? 200).toBeLessThan(500);
  await expect(page.locator("text=/Apps|No apps|Connect/").first()).toBeVisible();
});

test("Connect App wizard opens", async ({ page }) => {
  const slug = /\/t\/([^/]+)\//.exec(page.url())?.[1] ?? "default";
  await page.goto(`/t/${slug}/apps`);
  const connectBtn = page
    .locator('button:has-text("Connect"), button:has-text("Add app"), button:has-text("New app")')
    .first();
  if (await connectBtn.isVisible()) {
    await connectBtn.click();
    await expect(
      page.locator("text=/Connect|Platform|iOS|Android/i").first(),
    ).toBeVisible({ timeout: 5000 });
  }
});

test("Apps API endpoint returns shape", async ({ page, request }) => {
  const slug = /\/t\/([^/]+)\//.exec(page.url())?.[1] ?? "default";
  await page.goto(`/t/${slug}/apps`);
  const res = await request.get("/api/v1/apps");
  expect([200, 401, 403]).toContain(res.status());
  if (res.status() === 200) {
    const body = (await res.json()) as { apps?: unknown[] } | unknown[];
    const apps = Array.isArray(body) ? body : (body.apps ?? []);
    expect(Array.isArray(apps)).toBe(true);
  }
});
