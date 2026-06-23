# Runbook: Backup failure

## Symptom

`scripts/backup-pg.sh` exit non-zero. Cron emails "backup failed".

## Impact

POTENTIAL SEV2 — service is fine; recovery capability degraded.

## Diagnosis

```bash
# Check cron log
sudo tail -50 /var/log/syslog | grep CRON

# Manually run with verbose
bash -x scripts/backup-pg.sh
```

## Resolution

### Out of disk on the backup target

- Free space at the destination.
- Reduce retention (see `BACKUP_KEEP_DAYS`).

### Permission denied (S3 upload)

- Renew the IAM credential.
- Verify the bucket policy still allows `s3:PutObject`.

### Database refusing connections

- Confirm `pg_isready` returns 0 from the backup host.

## Post-incident

- Take a manual backup ASAP.
- Verify previous backup integrity:
  `pg_restore --list /backup/latest.dump | head`
