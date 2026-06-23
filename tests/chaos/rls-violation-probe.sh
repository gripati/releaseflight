#!/usr/bin/env bash
#
# Drill: RLS violation probe
# --------------------------
# Send a cross-tenant request as an unauthenticated client. The system
# must NEVER respond with a 200; the only acceptable responses are
# 401, 403, or 404.
#
# This is a smoke test — the real RLS coverage is in the database
# tests. This drill is what an alerting system would catch live.

. "$(dirname "$0")/lib.sh"

require_healthy

PROBES=(
  "/api/v1/t/nonexistent-tenant-zz/dashboard"
  "/api/v1/apps/00000000-0000-0000-0000-000000000000"
  "/api/v1/apps/00000000-0000-0000-0000-000000000000/metadata"
  "/api/v1/credentials"
  "/api/v1/audit"
)

fail_count=0
for p in "${PROBES[@]}"; do
  s=$(http_status "$BASE_URL$p")
  if [[ "$s" =~ ^(401|403|404)$ ]]; then
    ok "$p → $s"
  else
    log "  ${red}✗ $p → $s (expected 401/403/404)${reset}"
    fail_count=$((fail_count+1))
  fi
done

if (( fail_count > 0 )); then
  fail "$fail_count probe(s) returned unexpected status"
fi

ok "RLS violation probe drill PASSED"
