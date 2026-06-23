#!/usr/bin/env node
/**
 * Dev launcher for @marquee/web.
 *
 * Runs `next dev` AND, once the server is listening, fires the route warm-up
 * in the background so every route template is compiled up-front. Without
 * this, webpack dev compiles each route ON FIRST CLICK (measured 0.3–2.1s),
 * which is the "I press a tab and it opens much later" delay. After warm-up,
 * interactive navigation is warm (~80–100ms).
 *
 * (Turbopack — `next dev --turbopack` — would avoid the cold compile entirely,
 * but it currently panics with "Next.js package not found" in this pnpm
 * monorepo layout, so we stay on webpack + warm-up.)
 *
 * Opt out of the warm-up with NO_WARMUP=1. Use `pnpm dev:plain` for a bare
 * `next dev` with no wrapper.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT ?? "3000";
const cwd = process.cwd();
const nextBin = resolve(cwd, "node_modules/next/dist/bin/next");
const warmupScript = fileURLToPath(new URL("./warmup-routes.mjs", import.meta.url));

// ── Launch next dev (same process Next would otherwise run) ────────────────
const child = spawn(process.execPath, [nextBin, "dev", "--port", PORT], {
  stdio: "inherit",
  env: process.env,
});

// Forward termination so Ctrl+C / turbo shutdown actually kills next dev.
let shuttingDown = false;
function forward(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    child.kill(sig);
  } catch {
    /* already gone */
  }
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});

// ── Background warm-up once the server answers ─────────────────────────────
if (process.env.NO_WARMUP !== "1") {
  const base = `http://localhost:${PORT}`;
  void (async () => {
    // Wait (bounded) for the dev server to start accepting connections.
    for (let i = 0; i < 150; i++) {
      if (shuttingDown) return;
      try {
        const res = await fetch(`${base}/api/v1/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (i === 149) return; // gave up — server never came up
    }
    if (shuttingDown) return;
    // Run the warm-up as a detached child; its progress prints inline. It must
    // not take the dev server down, so failures are swallowed.
    const warm = spawn(process.execPath, [warmupScript], {
      stdio: "inherit",
      env: { ...process.env, BASE_URL: base },
    });
    warm.on("error", () => {
      /* warm-up is best-effort */
    });
  })();
}
