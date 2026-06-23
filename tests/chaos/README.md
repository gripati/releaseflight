# Chaos engineering tests

Manual + automated drills that prove the system degrades cleanly under
infrastructure failure. Each script:

1. Verifies the system is healthy.
2. Induces a fault.
3. Asserts the user-visible behaviour is **graceful** (no 5xx storm,
   no data corruption, clear error message).
4. Restores the service and verifies recovery.

These scripts are designed to be run **against the local docker-compose
stack** (`docker compose up -d`), not against production. They depend on
`docker`, `curl`, `jq`.

## Drills

| Script                     | Fault                                       | Expected behaviour                                 |
|----------------------------|---------------------------------------------|----------------------------------------------------|
| `redis-flap.sh`            | Stop redis 10 s, then restart               | Rate-limit fails open, sessions recover            |
| `postgres-kill.sh`         | Stop postgres                               | API returns 503 from readyz; status page degraded  |
| `storage-offline.sh`       | Stop MinIO                                  | Uploads 503 with `STORAGE_UNAVAILABLE`; reads cached |
| `worker-down.sh`           | Stop worker container                       | Jobs queue up; SSE shows "queued" indefinitely     |
| `rls-violation-probe.sh`   | Send cross-tenant request                   | 404/403; metric `gp_rls_violations_total` ticks    |
| `tenant-context-missing.sh`| Hit handler with no tenant context          | 500 with INTERNAL_ERROR; NO data leakage           |

Run all of them in order with `./run-all.sh` (drains stack, then runs each).

## Notes

- The drills are **read-only with respect to data** — they never DROP /
  truncate. The worst they do is bounce a container.
- Each script prints a green ✓ or red ✗ summary and exits non-zero on
  unexpected behaviour. CI can call them in nightly runs.
- For production chaos, use a feature-flagged proxy like Toxiproxy or
  Linkerd fault injection — **never** kill production infra to test.
