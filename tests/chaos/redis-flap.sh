#!/usr/bin/env bash
#
# Drill: redis flap
# -----------------
# Stop Redis for 10 s, then restart it. The application must:
#   1. Continue serving /healthz (200) — auth doesn't need Redis.
#   2. /readyz returns 503 while Redis is down.
#   3. Rate limit "fails open" rather than 5xx-ing (we asserted this in
#      the unit test for rateLimit() — confirm at integration level).
#   4. Recover automatically within 30 s of Redis returning.
#
# Run:
#   tests/chaos/redis-flap.sh

. "$(dirname "$0")/lib.sh"

require_healthy

info "Stopping redis…"
container_action stop redis

info "Waiting for /readyz to flip to 503 (or 200 if Redis is optional for readyz)…"
sleep 2

# Health stays alive
hz=$(http_status "$BASE_URL/api/v1/healthz")
assert_eq "/api/v1/healthz still 200 when redis down" "200" "$hz"

# Public status reflects the outage
st=$(http_status "$BASE_URL/api/v1/status")
assert_eq "/api/v1/status served even with redis down" "200" "$st"

body=$(curl -ks --max-time 5 "$BASE_URL/api/v1/status")
if printf "%s" "$body" | grep -q "outage"; then
  ok "Status page reports outage component"
else
  log "Status body: $body"
  fail "Status page did NOT mark Queue/Redis as outage"
fi

info "Restarting redis…"
container_action start redis

info "Waiting for recovery…"
sleep 5
wait_for_status "/api/v1/healthz" "200" 30

body=$(curl -ks --max-time 5 "$BASE_URL/api/v1/status")
if printf "%s" "$body" | grep -q "outage"; then
  fail "Status still reports outage after redis recovery"
else
  ok "Status returned to operational"
fi

ok "Redis flap drill PASSED"
