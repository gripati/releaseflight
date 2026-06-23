#!/usr/bin/env bash
#
# Postgres restore script. DESTRUCTIVE — drops and recreates the target
# database. Always run from a maintenance window with web + worker
# stopped.
#
# Usage:
#   scripts/restore-pg.sh /path/to/gp-YYYYMMDDTHHMMSSZ.dump

set -euo pipefail

DUMP_FILE="${1:?"Usage: $0 <dump-file>"}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-gp}"
PG_DB="${PG_DB:-gamepublisher}"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Dump not found: $DUMP_FILE" >&2
  exit 1
fi
if [[ -z "${PGPASSWORD:-}" ]]; then
  echo "PGPASSWORD must be set" >&2
  exit 1
fi

echo "⚠️  ABOUT TO RESTORE INTO ${PG_DB} FROM ${DUMP_FILE}"
echo "    This will DROP and recreate the database. All current data will be lost."
read -r -p "Type the database name '${PG_DB}' to confirm: " confirm
if [[ "$confirm" != "$PG_DB" ]]; then
  echo "Aborted."
  exit 1
fi

echo "→ Pre-restore safety dump"
SAFETY="./data/backups/pre-restore-$(date -u +%s).dump"
mkdir -p "$(dirname "$SAFETY")"
pg_dump --host="$PG_HOST" --port="$PG_PORT" --username="$PG_USER" \
  --dbname="$PG_DB" --format=custom --file="$SAFETY" || true

echo "→ Drop + recreate"
psql --host="$PG_HOST" --port="$PG_PORT" --username="$PG_USER" --dbname=postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${PG_DB}";
CREATE DATABASE "${PG_DB}" WITH OWNER "${PG_USER}";
SQL

echo "→ Restoring"
pg_restore --host="$PG_HOST" --port="$PG_PORT" --username="$PG_USER" \
  --dbname="$PG_DB" --no-owner --no-privileges --exit-on-error \
  --jobs=4 "$DUMP_FILE"

echo "→ Applying any newer migrations"
pnpm --filter @marquee/db prisma:migrate:deploy

echo "Done. Safety dump kept at $SAFETY"
