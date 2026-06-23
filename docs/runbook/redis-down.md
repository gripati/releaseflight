# Runbook: Redis down

## Symptom

Sessions don't persist; users get logged out on every request. CSRF
verification fails. Background workers stuck. `/readyz` returns 503.

## Impact

SEV1 — auth + queue both unavailable.

## Diagnosis

```bash
docker compose ps redis
docker compose logs --tail=200 redis

redis-cli -h localhost -p 6379 ping     # expect: PONG
redis-cli -h localhost INFO memory       # expect used_memory < maxmemory
redis-cli -h localhost INFO clients      # expect < max_clients
```

## Resolution

### Container dead

```bash
docker compose restart redis
# If data was important and AOF intact, recovery is automatic
```

### Out of memory

```bash
# We use maxmemory-policy allkeys-lru — but cache keys eviction can take
# a few seconds. Verify policy:
redis-cli CONFIG GET maxmemory-policy
# If misconfigured:
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

### Connection storm

```bash
redis-cli CLIENT LIST | wc -l
redis-cli CLIENT KILL TYPE normal     # disconnects idle clients
```

## Post-incident

- Add a HA replica if SLO needs > 99.9 %
- Schedule a quarterly chaos test that kills redis for 30 s during
  business hours and verifies the app degrades gracefully (login still
  works using DB-backed session lookup as fallback).
