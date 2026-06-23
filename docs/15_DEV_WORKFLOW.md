# Development workflow

This project ships **three** local-development modes. Pick the one that
matches what you're actually doing right now.

```
                            ┌────────────────────────────────────────────┐
       pnpm dev             │  HMR ✓ — instant edit feedback             │
                            │  Nav  ✗ — 200–700 ms first-visit penalty   │
                            │  Use when: actively writing code           │
                            └────────────────────────────────────────────┘

                            ┌────────────────────────────────────────────┐
       pnpm fast            │  HMR ✗ — full rebuild on each save (2–4s)  │
   (build + start + watch)  │  Nav  ✓ — every page <50 ms                │
                            │  Use when: clicking through the app to     │
                            │  test flows / show stakeholders            │
                            └────────────────────────────────────────────┘

                            ┌────────────────────────────────────────────┐
       pnpm start           │  HMR ✗ — needs manual rebuild              │
   (after pnpm build)       │  Nav  ✓ — every page <50 ms                │
                            │  Use when: production-like, no edits       │
                            └────────────────────────────────────────────┘
```

## TL;DR

| Scenario | Command |
|---|---|
| Writing UI code, want instant Tailwind reload | `pnpm dev` |
| Demo to a teammate, want zero compile lag | `pnpm fast` |
| Smoke-test the production build | `pnpm build && pnpm start` |
| Pre-compile every route in `pnpm dev` so first-clicks aren't slow | `pnpm warmup` |

---

## Mode A — `pnpm dev` (default, webpack + HMR)

```bash
pnpm dev
```

- **Boot:** ~3 seconds
- **First click on a new route:** 200–700 ms (Next compiles the route on-demand)
- **Subsequent visits:** ~80–120 ms
- **Editing a file:** Fast Refresh reloads the affected component in <250 ms

### Removing the first-click penalty: `pnpm warmup`

In a second terminal, after `pnpm dev` reports "Ready":

```bash
pnpm warmup
```

This GETs every primary route once so Next compiles them all up front
(~11 seconds total, one-off). Afterwards every navigation is <150 ms,
*including* the first visit to each page in a brand-new browser tab.

The warmup script is idempotent — re-run it any time the dev server has
been restarted.

> **Note on Turbopack:** `pnpm dev:turbo` exists but currently panics
> with "Next.js package not found" on pnpm monorepos
> ([next.js#53476](https://github.com/vercel/next.js/issues/53476)).
> Once that bug ships a fix, switch the default in `apps/web/package.json`.

---

## Mode B — `pnpm fast` (production build + auto-rebuild)

```bash
pnpm fast
```

This is the **professional sweet spot** for "I'm clicking through the
app right now" usage:

1. Runs `next build` (10–30 s on a warm cache)
2. Starts `next start` — every route already compiled, navigation is
   indistinguishable from production
3. Watches `apps/web/src` + `packages/*/src` with `fswatch`
   (macOS) / `inotifywait` (Linux)
4. On any `.ts`/`.tsx`/`.css` save: re-builds (2–4 s incremental) and
   restarts the server. The page you're on shows a brief "connection
   refused" for 1–2 seconds, then reloads automatically.

### Prerequisites
- macOS: `brew install fswatch`
- Linux: `apt install inotify-tools`

### When this beats `pnpm dev`
- You're hopping between Dashboard → Apps → Credentials repeatedly
- You're demoing the app to someone
- You're showing performance characteristics to a stakeholder
- You hate seeing `[Fast Refresh] rebuilding` in the console

### When `pnpm dev` is still better
- You're tweaking a single component repeatedly (HMR ≪ full rebuild)
- You're styling — Tailwind v4 hot reload is sub-second under HMR

---

## Mode C — `pnpm start` (pure production)

```bash
pnpm build      # one-off
pnpm start
```

Identical to Mode B but with NO file watching. Best for:
- CI smoke tests
- Final performance verification before a deploy
- Inspecting the actual bytes that will go into Docker

---

## Why dev mode feels slow without warmup

Next.js dev mode compiles route bundles **on-demand**. When you visit a
URL for the first time:

1. Webpack/Turbopack resolves the route's module graph (~1100 modules
   for our dashboard pages, since we transpile six workspace packages).
2. Compiles to JS.
3. Sends a "rebuilt" event to the browser → you see
   `[Fast Refresh] rebuilding` in DevTools console.
4. Server-renders the React tree (your `requireSession` + DB queries).

Steps 1–3 are 200–700 ms of pure compile work. There is no caching
between dev-server restarts; every restart re-pays the cost on first
visit.

Production mode does steps 1–3 **once during `next build`** and ships
the output. Route navigation becomes ~10–30 ms, which is why `pnpm fast`
feels instantaneous.

---

## Implementation files

- [`scripts/fast-dev.sh`](../scripts/fast-dev.sh) — file watcher + production server orchestrator
- [`scripts/warmup-routes.mjs`](../scripts/warmup-routes.mjs) — route pre-compiler
- [`apps/web/package.json`](../apps/web/package.json) — `dev` / `dev:turbo` / `build` / `start` / `warmup` scripts
- [`.npmrc`](../.npmrc) — pnpm config (non-hoisted, with Prisma + sharp hoists)
- [`apps/web/next.config.mjs`](../apps/web/next.config.mjs) — `output: "standalone"` for the Dockerfile, optimisations
