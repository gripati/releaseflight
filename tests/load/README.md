# k6 load tests

Industry-standard load scripts that double as capacity-planning artifacts.
All scripts assume a running stack (web + worker + postgres + redis +
minio). Run from the repo root:

```bash
# Baseline soak — 5 minutes of light constant traffic
k6 run tests/load/baseline.js

# Authentication burst — verify per-email and per-IP rate limits hold
k6 run -e BASE_URL=http://localhost:3000 tests/load/auth-burst.js

# Public probe burst — healthz / status / readyz must stay sub-100 ms p95
k6 run tests/load/public-probes.js

# Metadata-push fairness — multiple tenants pushing concurrently
# (requires authenticated cookies — see push-fairness.js header)
k6 run tests/load/push-fairness.js
```

## SLO targets exercised

These scripts assert the SLO targets from
[`packages/observability/src/slo.ts`](../../packages/observability/src/slo.ts):

| Script           | Target                                          |
|------------------|-------------------------------------------------|
| baseline.js      | `http_req_duration p95 < 500 ms`                |
| auth-burst.js    | At least 50 % rate-limited under burst, no 5xx  |
| public-probes.js | `http_req_duration p99 < 100 ms`, error rate=0  |
| push-fairness.js | Per-tenant p95 < 2 s, no tenant starved (>3x)   |

## Tooling

- [`k6`](https://k6.io/docs/getting-started/installation/) ≥ v0.50
- Optional: pipe results to a Prometheus pushgateway via
  `K6_PROMETHEUS_RW_SERVER_URL` so dashboards stay populated.
