#!/usr/bin/env bash
# Shared helpers for chaos scripts. Source from each drill:
#   . "$(dirname "$0")/lib.sh"

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
green="\033[32m"; red="\033[31m"; yellow="\033[33m"; reset="\033[0m"

log()  { printf "%s\n" "$1"; }
info() { printf "${yellow}→ %s${reset}\n" "$1"; }
ok()   { printf "${green}✓ %s${reset}\n" "$1"; }
fail() { printf "${red}✗ %s${reset}\n" "$1"; exit 1; }

http_status() {
  curl -ks -o /dev/null -w "%{http_code}" --max-time 5 "$1"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$label (got $actual)"
  else
    fail "$label: expected $expected, got $actual"
  fi
}

assert_lt() {
  local label="$1" upper="$2" actual="$3"
  if (( actual < upper )); then
    ok "$label ($actual < $upper)"
  else
    fail "$label: $actual not < $upper"
  fi
}

require_healthy() {
  info "Verifying baseline health…"
  local s
  s=$(http_status "$BASE_URL/api/v1/healthz")
  [[ "$s" == "200" ]] || fail "healthz is $s, expected 200 — abort drill"
  ok "Baseline healthy"
}

wait_for_status() {
  local path="$1" expected="$2" tries="${3:-30}"
  for ((i=0; i<tries; i++)); do
    local s
    s=$(http_status "$BASE_URL$path")
    if [[ "$s" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  fail "Timed out waiting for $path → $expected"
}

container_action() {
  local action="$1" service="$2"
  docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" "$action" "$service" >/dev/null
}
