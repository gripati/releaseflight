#!/usr/bin/env bash
# Run every chaos drill in sequence. Stops on the first failure.
#
# Usage:
#   tests/chaos/run-all.sh
#
# Expected: green ✓ for each drill. Total time ~3 minutes.

set -euo pipefail
cd "$(dirname "$0")"

DRILLS=(
  "rls-violation-probe.sh"
  "tenant-context-missing.sh"
  "redis-flap.sh"
  "storage-offline.sh"
  "postgres-kill.sh"
  "worker-down.sh"
)

for drill in "${DRILLS[@]}"; do
  echo ""
  echo "════════ $drill ════════"
  bash "./$drill"
done

echo ""
echo "All chaos drills passed."
