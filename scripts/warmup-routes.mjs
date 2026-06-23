#!/usr/bin/env node
/**
 * Route warm-up — fires HEAD requests to every primary route so Next.js
 * compiles them all UP FRONT in dev mode. Without this, the first visit
 * to each route in the browser pays a 200-700ms compile penalty.
 *
 * Run alongside `pnpm dev` from a second terminal:
 *
 *     pnpm dev               # terminal 1
 *     pnpm --filter @marquee/web warmup   # terminal 2, once the server is up
 *
 * The script is idempotent: it can be re-run safely; already-compiled
 * routes return instantly.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// Public routes always probed.
// /status and /api/v1/status import `@marquee/observability` — safe to warm
// now that the package is declared in apps/web/package.json and listed in
// next.config.mjs `transpilePackages` (previously an undeclared dep, whose
// `Module not found` error poisoned the whole dev server when compiled).
const PUBLIC = [
  "/login",
  "/status",
  "/api/v1/healthz",
  "/api/v1/status",
  "/api/v1/auth/csrf-token",
];

// Tenant-scoped routes — warmed up using the default seed tenant slug.
// The compiled output is keyed by the ROUTE TEMPLATE ([tenantSlug]/[appId]),
// not the concrete slug/id, so a placeholder slug + appId compiles the exact
// modules the user hits under their real workspace — they just redirect to
// /login (no cookie) AFTER the segment has already compiled. That's the point.
const SLUG = process.env.WARMUP_TENANT ?? "default";
const APP = process.env.WARMUP_APP ?? "warmup";
const TENANT = [
  `/t/${SLUG}/apps`,
  `/t/${SLUG}/credentials`,
  `/t/${SLUG}/jobs`,
  `/t/${SLUG}/audit`,
  `/t/${SLUG}/team`,
  `/t/${SLUG}/settings`,
];

// Per-app tabs — the heaviest segments to compile (and the ones the user
// switches between most). Warmed with a placeholder appId.
const APP_TABS = [
  "pulse",
  "metadata",
  "keywords",
  "analytics",
  "screenshots",
  "previews",
  "deploy",
  "builds",
  "history",
  "overview",
].map((tab) => `/t/${SLUG}/apps/${APP}/${tab}`);

const ROUTES = [...PUBLIC, ...TENANT, ...APP_TABS];

const colour = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const green = (s) => colour("32", s);
const yellow = (s) => colour("33", s);
const dim = (s) => colour("2", s);

async function probe(path) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "gp-warmup/1.0" },
    });
    const ms = Math.round(performance.now() - t0);
    const dot = ms < 100 ? green("●") : ms < 800 ? yellow("●") : colour("31", "●");
    console.log(`  ${dot} ${path.padEnd(40)} ${dim(`HTTP ${res.status} · ${ms}ms`)}`);
    return ms;
  } catch (err) {
    console.log(`  ${colour("31", "✗")} ${path}  ${dim(String(err.message ?? err))}`);
    return null;
  }
}

async function main() {
  console.log(dim(`Warming up ${ROUTES.length} routes against ${BASE}…\n`));
  const t0 = performance.now();
  const results = [];
  for (const path of ROUTES) {
    results.push(await probe(path));
  }
  const total = Math.round(performance.now() - t0);
  const ok = results.filter((r) => r !== null).length;
  console.log("");
  console.log(dim(`Done in ${total}ms — ${ok}/${ROUTES.length} routes warmed.`));
  if (ok < ROUTES.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
