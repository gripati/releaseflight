#!/usr/bin/env bash
#
# Drill: tenant-context-missing
# -----------------------------
# This is a defensive check: even if a handler forgot to call requireSession,
# Postgres RLS denies cross-tenant queries by default. The drill simulates
# an attacker hitting a tenant-scoped handler with NO session cookie.
#
# Acceptable behaviour:
#   - 401 / 403 / 404  → defence in depth
#   - 500 with INTERNAL_ERROR (sanitised) → tenant context missing assertion
#
# UNACCEPTABLE:
#   - 200 with a tenant's data
#   - 500 with stack trace / "tenantId" / private values

. "$(dirname "$0")/lib.sh"

require_healthy

PROBES=(
  "/api/v1/t/default/dashboard"
  "/api/v1/apps"
  "/api/v1/credentials"
  "/api/v1/jobs"
  "/api/v1/audit"
)

fail_count=0
for p in "${PROBES[@]}"; do
  out=$(curl -ks --max-time 5 -w "\n%{http_code}" "$BASE_URL$p")
  body=$(printf "%s" "$out" | head -n -1)
  status=$(printf "%s" "$out" | tail -n 1)

  if [[ "$status" =~ ^(200)$ ]]; then
    # 200 OK is only acceptable if it's an empty list (no data leak)
    if printf "%s" "$body" | grep -Eq '^\s*\[\s*\]\s*$|"\w+":\s*\[\s*\]'; then
      ok "$p → 200 (empty list, safe)"
    else
      log "  ${red}✗ $p → 200 with data: $body${reset}"
      fail_count=$((fail_count+1))
    fi
  elif [[ "$status" =~ ^(401|403|404|500)$ ]]; then
    if printf "%s" "$body" | grep -qiE "stack|prisma|tenantId.*=|password|secret"; then
      log "  ${red}✗ $p leaked internal details${reset}: $body"
      fail_count=$((fail_count+1))
    else
      ok "$p → $status (no leak)"
    fi
  else
    log "  ${red}✗ $p → $status (unexpected)${reset}"
    fail_count=$((fail_count+1))
  fi
done

if (( fail_count > 0 )); then
  fail "$fail_count probe(s) failed safety check"
fi

ok "Tenant-context-missing drill PASSED"
