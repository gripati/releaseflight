#!/usr/bin/env bash
#
# Synthetic monitor — hits the critical public probes every minute from
# cron / Kubernetes CronJob. Designed to be cheap, fast and obvious in
# its output. Pipe to PagerDuty / OpsGenie via the exit code.
#
# ENV: BASE_URL (e.g. https://app.gamepublisher.io)

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TIMEOUT="${TIMEOUT:-10}"

check() {
  local name="$1"
  local url="$2"
  local expect="${3:-200}"
  local code
  code=$(curl -ksS -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$url")
  if [[ "$code" != "$expect" ]]; then
    echo "FAIL $name $url → HTTP $code (expected $expect)" >&2
    return 1
  fi
  echo "OK   $name $url → $code"
  return 0
}

errors=0
check "healthz" "${BASE_URL}/api/v1/healthz" 200 || errors=$((errors+1))
check "status"  "${BASE_URL}/api/v1/status"  200 || errors=$((errors+1))
check "login"   "${BASE_URL}/login"          200 || errors=$((errors+1))

if [[ $errors -gt 0 ]]; then
  echo "Synthetic canary FAILED ($errors checks)" >&2
  exit 1
fi
echo "All synthetic checks green."
