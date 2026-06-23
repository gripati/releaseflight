# Runbook: Slow database

## Symptom

`gp_http_duration_seconds` p99 > 1 s. `gp_db_connections_active` plateau
at pool maximum. Alert: `DatabaseConnectionsExhausted`.

## Impact

SEV2 — users see timeouts on metadata fetch / push.

## Diagnosis

```sql
-- Long-running queries
SELECT pid, state, query_start, now() - query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds'
ORDER BY duration DESC;

-- Locks holding things back
SELECT * FROM pg_stat_activity WHERE wait_event_type IS NOT NULL;

-- Table sizes / hot spots
SELECT relname, n_live_tup, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

## Resolution

### Kill specific runaway query (last resort)

```sql
SELECT pg_cancel_backend(<pid>);   -- soft
SELECT pg_terminate_backend(<pid>); -- hard
```

### Pool exhausted

```bash
# Scale workers DOWN temporarily so they release connections
kubectl scale deployment gp-worker --replicas=1
```

### Bloated table

```sql
VACUUM (VERBOSE, ANALYZE) "App";
-- Or for severe bloat:
VACUUM FULL "App";  -- WARNING: takes table-level lock
```

## Post-incident

- Add a missing index if a sequential scan caused the slowdown
- Consider connection-pool size bump on Prisma (default = 10 per process)
- Profile the route handler with `EXPLAIN ANALYZE`
