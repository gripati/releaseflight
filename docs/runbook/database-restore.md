# Runbook: Database restore

## Symptom

Data loss / corruption. Need to roll back to a point in time.

## Impact

SEV1 — service unavailable during restore.

## Decision matrix

| Scope | Tool |
|-------|------|
| Whole DB to last full backup | `pg_restore` from latest `pg_basebackup` |
| Whole DB to point in time | WAL-G + WAL replay |
| Single tenant (no PITR) | Application-level export/import via `gp-cli` |
| Single table | `pg_dump --table` + `pg_restore` |

## Procedure — full restore from latest `pg_basebackup`

```bash
# 1. Stop the app + worker
docker compose stop web worker

# 2. Snapshot the corrupt DB just in case
docker compose exec postgres pg_dump -U gp -Fc marquee \
  > /backup/pre-restore-$(date +%s).dump

# 3. Drop and recreate
docker compose exec postgres psql -U gp -c "DROP DATABASE marquee"
docker compose exec postgres psql -U gp -c "CREATE DATABASE marquee"

# 4. Restore
docker compose exec postgres pg_restore -U gp -d marquee /backup/latest.dump

# 5. Re-run migrations to catch up if backup predates the latest migration
pnpm db:migrate:deploy

# 6. Verify
docker compose exec postgres psql -U gp -d marquee -c "\dt"

# 7. Restart app
docker compose start web worker

# 8. Run smoke tests
pnpm test:integration
```

## Procedure — single-tenant restore

If only one tenant is affected, use the application-level dump/load
(`gp-cli export --tenant <slug>` then `gp-cli import --tenant <slug>`).
This is non-destructive to other tenants.

## Post-incident

- Compare restored row counts vs. application metrics
- Notify affected tenant OWNERs in writing
- Update RTO/RPO numbers in `docs/13_STABILITY_OPS.md` if the drill
  exposed gaps
