# Runbook: Worker stalled

## Symptom

`gp_jobs_in_progress{queue="metadata.push"}` grows without bound. Users
report "Push is taking forever". `bull-board` shows stuck jobs.

## Impact

SEV2 — async operations don't complete.

## Diagnosis

```bash
# Worker container alive?
docker compose ps worker
docker compose logs --tail=200 worker

# Is the worker connected to Redis?
docker compose logs worker | grep -i "Redis"

# Queue stats
redis-cli LLEN bull:metadata.push:wait
redis-cli LLEN bull:metadata.push:active
redis-cli LLEN bull:metadata.push:failed

# Check Prisma connections from the worker
docker compose exec worker node -e "console.log(process.env.DATABASE_URL)"
```

## Resolution

### Worker process unhealthy

```bash
docker compose restart worker
```

### Queue clogged with retries

```bash
# Pause new jobs while you investigate:
redis-cli HSET bull:metadata.push:meta paused 1

# Drain failed list (older than 24h):
redis-cli LRANGE bull:metadata.push:failed 0 -1
# Inspect, then DEL specific keys.
```

### Stuck jobs holding tenant context

If the AsyncLocalStorage context leaked, kill the worker process. The
process model guarantees a fresh context per spawned worker. SIGTERM
sends a graceful shutdown.

## Post-incident

- Verify `gp_jobs_total{status="failed"}` matches what was in the
  failed list — discrepancies indicate a metric emission bug
- If a single job kept failing, add it to fixtures + test
