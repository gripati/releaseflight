# Runbook: Deploy rollback

## Symptom

A release just shipped and:
- Error rate jumped
- A regression test would have caught
- Customers reporting via support

## Impact

SEV2 — newly broken feature.

## Decision

Rollback if **any** of:
- Error rate above 1 % for 5 minutes
- SLO burn rate above 2×
- Specific critical feature (login, push, AAB upload) clearly broken

## Procedure

### Self-host (docker compose)

```bash
# Identify the previous tag
docker image ls ghcr.io/gripati/gp-web --format "{{.Tag}}"

# Edit docker-compose.yml to pin the previous tag
sed -i 's|ghcr.io/gripati/gp-web:.*|ghcr.io/gripati/gp-web:<previous>|' docker-compose.yml

# Restart
docker compose pull web worker
docker compose up -d --force-recreate web worker

# Verify
curl -fsS http://localhost:3000/api/v1/healthz
```

### Kubernetes

```bash
kubectl rollout undo deployment/gp-web
kubectl rollout undo deployment/gp-worker
kubectl rollout status deployment/gp-web --timeout=2m
```

### Database migration consideration

If the rolled-back release contained a destructive migration, the data
might be incompatible with the previous code:

- Compatible (additive migration: new nullable column) → rollback safe.
- Incompatible (dropped column, type narrowed) → DB restore required first.
  See `database-restore.md`.

## Post-incident

- Write the post-mortem
- Add the missing CI check / test
- Bump the release process to require ≥ 30 min in staging before prod
