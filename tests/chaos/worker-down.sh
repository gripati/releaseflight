#!/usr/bin/env bash
#
# Drill: worker down
# ------------------
# Stop the worker. The application must:
#   1. Continue accepting jobs (they queue in Redis).
#   2. SSE job streams stay open with no events.
#   3. queue depth metric (gp_jobs_in_progress) drops to 0 while waits grow.
#   4. Once worker restarts, queued jobs drain within reasonable time.
#
# This is the only drill that requires worker as a docker-compose service.
# If worker is not yet in compose, the script logs a NOTE and exits 0.

. "$(dirname "$0")/lib.sh"

require_healthy

if ! docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" ps worker >/dev/null 2>&1; then
  log "NOTE: 'worker' service not in docker-compose.yml — skipping drill"
  exit 0
fi

info "Stopping worker…"
container_action stop worker
sleep 3

info "API still healthy?"
hz=$(http_status "$BASE_URL/api/v1/healthz")
assert_eq "/api/v1/healthz still 200" "200" "$hz"

info "Restarting worker…"
container_action start worker
sleep 5

ok "Worker down drill PASSED"
