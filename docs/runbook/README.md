# Runbook index

Operational playbooks for Release Flight. Each runbook follows the same
shape: **Symptom → Impact → Diagnosis → Resolution → Post-incident**.

| Runbook | When to use |
|---------|------------|
| [api-down.md](./api-down.md) | Health checks failing / 5xx on every endpoint |
| [high-error-rate.md](./high-error-rate.md) | 5xx rate above 1 % for 5+ minutes |
| [slow-database.md](./slow-database.md) | API p99 latency above SLO, pg_stat_activity full |
| [redis-down.md](./redis-down.md) | Sessions, cache or queue failing |
| [disk-full.md](./disk-full.md) | Storage proxy returns 5xx, upload errors |
| [apple-integration-fail.md](./apple-integration-fail.md) | Apple API 401/403/5xx outage |
| [google-integration-fail.md](./google-integration-fail.md) | Google Play API 401/403/5xx outage |
| [worker-stalled.md](./worker-stalled.md) | Jobs queue depth keeps growing |
| [rls-violation.md](./rls-violation.md) | `gp_rls_violations_total` spiking |
| [database-restore.md](./database-restore.md) | Full or single-tenant restore needed |
| [backup-failure.md](./backup-failure.md) | Daily backup didn't ship |
| [credential-leak-suspected.md](./credential-leak-suspected.md) | A `.p8` or service-account JSON may have leaked |
| [deploy-rollback.md](./deploy-rollback.md) | Last release introduced a regression |

## Severity

| Sev | Examples | Response |
|-----|----------|----------|
| SEV1 | Full outage, data loss, security breach | Page on-call immediately, all-hands |
| SEV2 | > 25 % of users impacted, critical feature broken | On-call within 15 min, status page update |
| SEV3 | One feature degraded, one tenant affected | On-call within 2h |
| SEV4 | Cosmetic, minor | Backlog ticket |

## After every incident

Schedule a blameless post-mortem within 48 hours. Write it up at
`docs/incidents/YYYY-MM-DD-<slug>.md` using this template:

```
# Incident: <title>
**Date / duration / severity / author**
## Summary  (executive)
## Timeline (UTC)
## Impact
## Root cause
## What went well
## What went wrong
## Action items (with owners)
## Lessons
```
