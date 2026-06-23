# Runbook: High error rate

## Symptom

`gp_http_requests_total{status=~"5.."}` exceeds 1 % of total for 5+ minutes.
Alertmanager fires `HighErrorRate`.

## Impact

SEV2 — users see intermittent failures, retries usually succeed.

## Diagnosis

```bash
# Top failing routes (last 10 min) via metrics
curl -s -H "Authorization: Bearer $METRICS_BEARER_TOKEN" \
  http://localhost:3000/api/v1/metrics | \
  grep '^gp_http_requests_total' | grep 'status="5'

# Tail logs for ERROR level
docker compose logs --tail=500 web | grep -i '"level":"error"'

# Apple/Google upstream?
curl -s http://localhost:3000/api/v1/health/deep \
  -H "Cookie: gp_session=<dev-token>" | jq '.checks'
```

## Resolution

- **Upstream Apple/Google outage** — activate maintenance banner, no user
  action available. Wait + post status update.
- **Internal regression** — `kubectl rollout undo` (see deploy-rollback.md).
- **Specific tenant abusing** — check audit log + apply rate limit override.
- **DB pool exhaustion** — see slow-database.md.

## Post-incident

- Open incident doc
- Add a synthetic monitor for the failing route if not yet covered
