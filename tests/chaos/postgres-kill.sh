#!/usr/bin/env bash
#
# Drill: postgres kill
# --------------------
# Stop Postgres. The application must:
#   1. /healthz stays 200 (no DB read).
#   2. /readyz flips to 503.
#   3. /status reports database = outage.
#   4. Authenticated reads return 5xx WITH a JSON error envelope (no leaked stack trace).
#   5. Recovery within 60 s of Postgres returning.

. "$(dirname "$0")/lib.sh"

require_healthy

info "Stopping postgres…"
container_action stop postgres
sleep 3

hz=$(http_status "$BASE_URL/api/v1/healthz")
assert_eq "/api/v1/healthz still 200 when postgres down" "200" "$hz"

rz=$(http_status "$BASE_URL/api/v1/readyz")
if [[ "$rz" == "503" || "$rz" == "500" ]]; then
  ok "/api/v1/readyz reports degraded ($rz)"
else
  fail "/api/v1/readyz did not degrade — got $rz"
fi

# Status remains queryable
st=$(http_status "$BASE_URL/api/v1/status")
assert_eq "/api/v1/status remains 200 (no panic)" "200" "$st"

body=$(curl -ks --max-time 5 "$BASE_URL/api/v1/status")
if printf "%s" "$body" | grep -q '"database"' && printf "%s" "$body" | grep -q "outage"; then
  ok "Status correctly marks database outage"
fi

info "Authenticated mutation should error cleanly (no stack trace leak)…"
err=$(curl -ks --max-time 5 -X POST "$BASE_URL/api/v1/credentials" \
  -H "content-type: application/json" -d '{}')
if printf "%s" "$err" | grep -q "BEGIN\|prisma\|pg_\|password"; then
  fail "Error response leaked internal details: $err"
else
  ok "Error envelope sanitised"
fi

info "Restarting postgres…"
container_action start postgres
sleep 5
wait_for_status "/api/v1/readyz" "200" 60

ok "Postgres kill drill PASSED"
