#!/usr/bin/env node
/**
 * Capture product screenshots from a running Release Flight instance.
 *
 * Drives a headless Chromium against a live stack (default http://localhost:3000),
 * logs in as the self-host owner, and saves PNGs to docs/assets/. Each step is
 * isolated — if one screen fails, the rest still capture.
 *
 * Prereqs:
 *   - A running stack (e.g. `./scripts/install.sh`).
 *   - Chromium for Playwright: `npx playwright install chromium`
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   OWNER_EMAIL=owner@example.com OWNER_PASSWORD=... \
 *   node scripts/capture-screenshots.mjs
 *
 * Tip: for a compelling demo, run this against an instance that already has a
 * connected app + metadata (not a fresh install) so the screens aren't empty.
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "assets");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.OWNER_PASSWORD ?? "change-me-after-first-login";
const NEW_PASSWORD = process.env.NEW_PASSWORD ?? "Demo-Passw0rd-2026!";

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  const shot = async (name) => {
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
      console.log(`✓ ${name}.png  (${page.url()})`);
    } catch (e) {
      console.log(`✗ ${name}: ${e.message}`);
    }
  };
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`✗ step "${label}" skipped: ${e.message}`);
    }
  };

  // 1. Login page (public)
  await step("login", async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await shot("01-login");
  });

  // 2. Sign in
  await step("sign-in", async () => {
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button:has-text("Sign in")');
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
  });

  // 3. Forced password change (first login), if shown
  await step("change-password", async () => {
    if (/change-password/.test(page.url())) {
      await shot("02-change-password");
      const pw = page.locator('input[type="password"]');
      const n = await pw.count();
      for (let i = 0; i < n; i++) await pw.nth(i).fill(NEW_PASSWORD);
      await page.locator('button[type="submit"], button:has-text("Update"), button:has-text("Change")').first().click();
      await page.waitForTimeout(1500);
    }
  });

  // Derive the tenant slug from the URL (…/t/<slug>/…) or via the account picker.
  let slug = null;
  const m = page.url().match(/\/t\/([^/]+)/);
  if (m) slug = m[1];
  if (!slug) {
    await step("tenant-picker", async () => {
      await page.goto(`${BASE_URL}/account/tenants`, { waitUntil: "domcontentloaded" });
      await shot("03-tenants");
      const link = page.locator('a[href*="/t/"]').first();
      if (await link.count()) {
        const href = await link.getAttribute("href");
        const mm = href?.match(/\/t\/([^/]+)/);
        if (mm) slug = mm[1];
      }
    });
  }
  console.log(`tenant slug: ${slug ?? "(unknown)"}`);

  // 4. Key authenticated screens
  const pages = slug
    ? [
        [`/t/${slug}/apps`, "04-apps"],
        [`/t/${slug}/credentials`, "05-credentials"],
        [`/t/${slug}/settings`, "06-settings"],
        [`/t/${slug}/team`, "07-team"],
      ]
    : [];
  for (const [path, name] of pages) {
    await step(name, async () => {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      await shot(name);
    });
  }

  await browser.close();
  console.log(`\nDone → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
