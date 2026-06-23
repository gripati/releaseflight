#!/usr/bin/env bash
#
# Postgres backup script. Designed for cron + a remote object store.
#
# Usage:
#   BACKUP_DIR=/var/backups/gp \
#   BACKUP_KEEP_DAYS=30 \
#   PG_HOST=localhost PG_USER=gp PG_DB=gamepublisher \
#   scripts/backup-pg.sh
#
# Set S3_BUCKET to also upload via `aws` CLI. Tags rotation is based on
# file mtime; pg_dump runs in custom format so `pg_restore` can read it.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-gp}"
PG_DB="${PG_DB:-gamepublisher}"

if [[ -z "${PGPASSWORD:-}" ]]; then
  echo "PGPASSWORD must be set (pull from your secret store)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR}/gp-${TS}.dump"

echo "→ Dumping ${PG_DB}@${PG_HOST}:${PG_PORT} to ${DEST}"
pg_dump \
  --host="$PG_HOST" \
  --port="$PG_PORT" \
  --username="$PG_USER" \
  --dbname="$PG_DB" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$DEST"

SIZE_BYTES=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST")
echo "✓ Wrote $((SIZE_BYTES / 1024 / 1024)) MB"

if [[ -n "${S3_BUCKET:-}" ]]; then
  echo "→ Uploading to s3://${S3_BUCKET}/postgres/$(basename "$DEST")"
  aws s3 cp --no-progress "$DEST" "s3://${S3_BUCKET}/postgres/$(basename "$DEST")"
fi

echo "→ Rotating backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -type f -name 'gp-*.dump' -mtime "+${KEEP_DAYS}" -print -delete || true

echo "Done."
