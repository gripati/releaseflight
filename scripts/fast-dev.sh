#!/usr/bin/env bash
#
# fast-dev — production build + start, with auto-rebuild on source change.
#
# Optimised for the case where you want INSTANT page navigation (no
# webpack on-demand compile) but you're still iterating on code. Watches
# apps/web/src + packages/*/src and triggers an incremental `next build`
# whenever a .ts/.tsx file changes. Build delta is normally 2-4s.
#
# This is the "third gear" between:
#   • `pnpm dev`         — Turbopack HMR (instant edit feedback, slower nav)
#   • `pnpm start`       — production mode (instant nav, no auto-rebuild)
#   • `pnpm fast`        — production mode + auto-rebuild  ← THIS
#
# Requires: fswatch (macOS) or inotifywait (Linux).
#   macOS:   brew install fswatch
#   Linux:   apt install inotify-tools

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
PID_FILE="/tmp/gp-fast-dev.pid"

green="\033[32m"; yellow="\033[33m"; red="\033[31m"; dim="\033[2m"; reset="\033[0m"

log() { printf "${dim}[$(date +%H:%M:%S)]${reset} %b\n" "$1"; }
ok()  { printf "${dim}[$(date +%H:%M:%S)]${reset} ${green}✓${reset} %s\n" "$1"; }
warn(){ printf "${dim}[$(date +%H:%M:%S)]${reset} ${yellow}⚠${reset} %s\n" "$1"; }
err() { printf "${dim}[$(date +%H:%M:%S)]${reset} ${red}✗${reset} %s\n" "$1"; }

# ──── prerequisites ────
if ! command -v fswatch >/dev/null 2>&1 && ! command -v inotifywait >/dev/null 2>&1; then
  err "Neither fswatch (macOS) nor inotifywait (Linux) is installed."
  err "  macOS:  brew install fswatch"
  err "  Linux:  apt install inotify-tools"
  exit 1
fi

# Load .env so the server has DATABASE_URL etc.
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

# CRITICAL: .env sets NODE_ENV=development (for `next dev`). Both `next build`
# and `next start` here REQUIRE production mode — building with NODE_ENV
# !=production silently breaks error-page generation (the build dies with a
# spurious "<Html> should not be imported outside of pages/_document" while
# prerendering /404,/500,/_error). Force it.
export NODE_ENV=production

# In production mode the instrumentation hook REFUSES to boot when the DB role
# is a SUPERUSER (it bypasses RLS). That guard is correct for real prod, but
# fast-dev runs production MODE against the local dev DB (role 'gp' is a
# superuser), so allow it here — this is a local-only convenience server.
# For a real deployment, connect as the NOSUPERUSER 'gp_app' role instead.
export MARQUEE_ALLOW_INSECURE_DB_ROLE=1

# ──── cleanup on exit ────
cleanup() {
  warn "Shutting down fast-dev"
  if [[ -f "$PID_FILE" ]]; then
    local pid; pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup INT TERM

# ──── start helpers ────
start_server() {
  log "Starting Next.js production server on :$PORT…"
  pnpm --filter @marquee/web start > /tmp/gp-fast-dev.log 2>&1 &
  echo $! > "$PID_FILE"
  # Wait for ready
  for _ in {1..30}; do
    if curl -sf "http://localhost:$PORT/api/v1/healthz" > /dev/null 2>&1; then
      ok "Server ready at http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done
  err "Server didn't come up — see /tmp/gp-fast-dev.log"
  return 1
}

stop_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid; pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # Belt-and-braces — kill anything still on the port
  lsof -ti:"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}

rebuild_and_restart() {
  log "Source change detected — rebuilding…"
  local t0=$(date +%s)
  if pnpm --filter @marquee/web build > /tmp/gp-fast-build.log 2>&1; then
    local t1=$(date +%s)
    ok "Build completed in $((t1 - t0))s"
    stop_server
    sleep 1
    start_server
  else
    err "Build failed — keeping the previous server running"
    tail -20 /tmp/gp-fast-build.log
  fi
}

# ──── initial build + start ────
log "Initial build…"
if pnpm --filter @marquee/web build > /tmp/gp-fast-build.log 2>&1; then
  ok "Initial build OK"
else
  err "Initial build failed:"
  tail -30 /tmp/gp-fast-build.log
  exit 1
fi
start_server

# ──── watch loop ────
log "Watching apps/web/src and packages/*/src for changes…"
WATCH_PATHS=(apps/web/src packages)

if command -v fswatch >/dev/null 2>&1; then
  fswatch -or --event=Updated --event=Created --event=Removed \
    --exclude='\.(test|spec)\.tsx?$' \
    --exclude='__tests__' \
    --exclude='\.turbo' \
    --exclude='\.next' \
    --exclude='node_modules' \
    "${WATCH_PATHS[@]}" | while read -r _ ; do
    # Debounce: drain rapid bursts
    sleep 0.5
    while read -t 0.2 -r _; do :; done < <(fswatch -1 "${WATCH_PATHS[@]}" 2>/dev/null) || true
    rebuild_and_restart
  done
else
  inotifywait -mqr -e modify -e create -e delete \
    --exclude '(\.test\.tsx?|__tests__|\.turbo|\.next|node_modules)' \
    "${WATCH_PATHS[@]}" | while read -r _; do
    sleep 0.5
    rebuild_and_restart
  done
fi
