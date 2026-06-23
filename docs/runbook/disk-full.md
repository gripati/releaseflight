# Runbook: Disk full

## Symptom

Storage proxy 5xx. Uploads fail with `ENOSPC`. nginx errors `client
intended to send too large body`.

## Impact

SEV2 — uploads and master-JSON export blocked.

## Diagnosis

```bash
df -h
du -sh /var/lib/docker/volumes/*       # find the offender
du -sh ./data/storage                  # filesystem provider
```

## Resolution

```bash
# 1. Clear orphan scratch files (1h TTL but verify)
find ./scratch -type f -mmin +60 -delete

# 2. Drop old preview videos that already exist upstream
# (preview rows where storageKey is set and uploadedAt > 90 days)
# Run via Prisma Studio or a one-shot script.

# 3. Rotate Docker logs (these can balloon quickly)
docker system prune -af --volumes --filter "until=24h"
```

## Post-incident

- Add a Prometheus alert at 70 % disk usage
- Move object storage off the local volume (S3/MinIO)
