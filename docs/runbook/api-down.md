# Runbook: API down

## Symptom

`/api/v1/healthz` returns non-200 or times out. Browser-side error
boundaries flood Sentry. PagerDuty fires `APIDownCritical` alert.

## Impact

SEV1 — full outage. No user can sign in or push.

## Diagnosis

```bash
# 1. Is the web container running?
docker compose ps                           # self-host
kubectl get pods -l app=gp-web              # SaaS

# 2. Tail logs
docker compose logs --tail=200 web
kubectl logs -l app=gp-web --tail=200 --follow

# 3. Check ready endpoint (requires auth — pre-shared)
curl -fsS http://localhost:3000/api/v1/readyz | jq

# 4. Check upstream proxy (nginx / cloud LB)
curl -I https://app.releaseflight.com/api/v1/healthz
```

Common causes:

- Web process OOM-killed (look for `Killed` in dmesg or pod last state)
- DB connection pool exhausted (see slow-database.md)
- Prisma migrations failed at boot (look for `prisma migrate` errors)
- Hung Node event loop (look for one CPU pinned at 100 %)

## Resolution

### If OOM:

```bash
docker compose restart web
# Raise memory limit if it keeps recurring:
#   container_memory_limit = 2Gi  → 4Gi
```

### If migration stuck:

```bash
# Take an exclusive lock with another instance, then run manually
pnpm db:migrate:deploy
```

### If hung event loop:

```bash
# Capture a CPU profile before restarting (useful for the post-mortem):
kill -USR1 <pid>            # writes node-debug-<pid>-<ts>.heapsnapshot
docker compose restart web
```

### Always:

1. Update the public status page → "Investigating".
2. Once `healthz` returns 200 for 2 minutes → "Resolved".
3. Open `docs/incidents/<date>-api-down.md`.

## Post-incident

- Confirm error budget burn (`Grafana → SLO`)
- Add a regression test if the cause was an in-house change
- Bump container resource limits if OOM
