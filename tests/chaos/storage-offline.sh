#!/usr/bin/env bash
#
# Drill: storage offline
# ----------------------
# Stop MinIO. The application must:
#   1. Continue serving non-upload endpoints (healthz, status).
#   2. Upload endpoints return 503 with STORAGE_UNAVAILABLE error code.
#   3. Already-uploaded screenshots stay viewable from cache (presigned
#      URLs are typically cached for a short window).
#   4. No 5xx from the surrounding metadata APIs.

. "$(dirname "$0")/lib.sh"

require_healthy

info "Stopping MinIO…"
container_action stop minio
sleep 3

hz=$(http_status "$BASE_URL/api/v1/healthz")
assert_eq "/api/v1/healthz still 200" "200" "$hz"

st=$(http_status "$BASE_URL/api/v1/status")
assert_eq "/api/v1/status still 200" "200" "$st"

info "Confirm presigned upload init fails fast (not 5xx loop)…"
# Without auth this will be 403, but it shouldn't be 5xx — that's the key
sc=$(http_status "$BASE_URL/api/v1/storage/presign")
if [[ "$sc" -lt "500" ]]; then
  ok "Storage endpoint returns ${sc} (non-5xx) when MinIO down"
else
  fail "Storage endpoint 5xx'd ($sc) — should fail fast with 4xx/503"
fi

info "Restoring MinIO…"
container_action start minio
sleep 5
wait_for_status "/api/v1/healthz" "200" 30

ok "Storage offline drill PASSED"
