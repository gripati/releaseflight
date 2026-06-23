# 13 — Stability & Operations ("Ömürlük Stabil Sistem")

Bu doküman, sistemin **ömürlük** (long-term, durable, predictable) çalışması için gerekli SLO/SLI'ları, runbook'ları, monitoring'i, chaos engineering pratiklerini ve operasyonel disiplinleri içerir.

## 13.0 İlke

**"Production'da olmayan davranış, V1'de yapılmaz."**

Yani: monitoring, alerting, runbook, chaos test, backup drill — bunlar V1.5'in **kabul kriterleridir**, nice-to-have değil. Aksi halde production'a çıkar, ilk büyük problem hayatı durdurur.

## 13.1 Service Level Objectives (SLO)

| SLI (Indicator) | SLO (Target) | Measurement Window | Notes |
|------------------|--------------|---------------------|-------|
| **API availability** | 99.0% (V1 self-host best-effort) / 99.9% SaaS | rolling 30d | `success_2xx + 3xx + 4xx_client / total` (5xx ve timeout = fail) |
| **API latency p99** | < 500ms (V1) / < 300ms (SaaS) | rolling 7d | non-streaming endpoint'ler |
| **Push success rate** | > 99% | rolling 30d | upstream Apple/Google fail HARİÇ (kendi hatamız) |
| **Job completion (SLA)** | < 5 dakika @ p99 (metadata.push) | rolling 7d | screenshot.upload < 60s @ p99 |
| **Data durability** | 99.999999% (S3 SLA) | yıllık | her tenant'ın data'sı |
| **RPO** (Recovery Point Obj.) | < 5 dakika (V1) / < 1 dakika (SaaS) | her DR drill | son backup'a göre data kaybı |
| **RTO** (Recovery Time Obj.) | < 1 saat (V1) / < 15 dakika (SaaS) | her DR drill | full restore süresi |
| **Mean Time To Detect** | < 5 dakika | her incident | alert tetiklenmesi |
| **Mean Time To Recover** | < 30 dakika | her incident | full restore |
| **Frontend FCP** | < 1.5s (3G fast) | rolling 7d | Real User Monitoring |
| **Frontend LCP** | < 2.5s | rolling 7d | RUM |

### 13.1.1 Error Budget

Aylık error budget hesabı:

```
Aylık dakika: 30 × 24 × 60 = 43,200 dk

V1 SLO 99.0%   → budget = 432 dk/ay (~7 saat) — generous, self-host
SaaS SLO 99.9% → budget = 43 dk/ay
```

**Burn rate alarm:**
- 1 saatte %2 yandı → 2x normal → warning
- 1 saatte %10 yandı → critical, on-call wake-up

### 13.1.2 SLO Yayını

`/status` endpoint + V2'de `status.releaseflight.com` (Cachet / Statuspage):

```
Last 30 days:
✓ API           99.94%   (budget remaining: 73%)
✓ Workers       99.99%
⚠ Apple Int.    99.21%   (upstream incident May 5)
✓ Google Int.   99.87%
```

## 13.2 Service Level Indicators (SLI) Implementasyonu

### 13.2.1 Prometheus Metrics

`packages/observability/src/metrics.ts`:

```ts
import { Counter, Histogram, Gauge, register } from "prom-client";

// HTTP layer
export const httpRequests = new Counter({
  name: "gp_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status", "tenant_plan"],
});

export const httpDuration = new Histogram({
  name: "gp_http_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Upstream API layer (Apple/Google)
export const upstreamRequests = new Counter({
  name: "gp_upstream_requests_total",
  help: "Upstream API calls",
  labelNames: ["provider", "endpoint", "status_class"],
});

export const upstreamDuration = new Histogram({
  name: "gp_upstream_duration_seconds",
  help: "Upstream API call duration",
  labelNames: ["provider", "endpoint"],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
});

// Job layer
export const jobsTotal = new Counter({
  name: "gp_jobs_total",
  help: "Background jobs processed",
  labelNames: ["queue", "status"],   // status: completed | failed | retried
});

export const jobDuration = new Histogram({
  name: "gp_job_duration_seconds",
  help: "Job processing duration",
  labelNames: ["queue"],
  buckets: [1, 5, 10, 30, 60, 300, 900, 1800, 3600],
});

export const jobsInProgress = new Gauge({
  name: "gp_jobs_in_progress",
  help: "Currently running jobs",
  labelNames: ["queue", "tenant_plan"],
});

// Tenant + business metrics
export const tenantsActive = new Gauge({
  name: "gp_tenants_active",
  help: "Tenants with activity in last 24h",
});

export const usagePushes = new Counter({
  name: "gp_usage_pushes_total",
  help: "Metadata pushes (for usage tracking)",
  labelNames: ["tenant_plan", "platform"],
});

// Auth & security
export const authAttempts = new Counter({
  name: "gp_auth_attempts_total",
  help: "Login attempts",
  labelNames: ["result"],   // success | failure | rate_limited | mfa_required
});

export const rlsViolationAttempts = new Counter({
  name: "gp_rls_violations_total",
  help: "RLS policy denied access (potential attack)",
  labelNames: ["table"],
});

// Infra
export const dbConnectionsActive = new Gauge({
  name: "gp_db_connections_active",
  help: "Active Prisma connections",
});

export const redisLatency = new Histogram({
  name: "gp_redis_latency_seconds",
  help: "Redis command latency",
  labelNames: ["command"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
});

// Export endpoint
export async function metricsHandler(): Promise<string> {
  return await register.metrics();
}
```

### 13.2.2 Grafana Dashboards

`infra/grafana/dashboards/` altında JSON tanımları:

1. **API Overview** — rps, p50/p95/p99 latency, error rate per route
2. **Upstream Integrations** — Apple/Google health (request rate, error rate, p99)
3. **Jobs** — queue depth, throughput, success rate, slow jobs
4. **Tenant Activity** — DAU, active tenants, push velocity (per-plan breakdown SaaS)
5. **Security** — auth failures, RLS violations, rate limit hits
6. **Infrastructure** — DB conn pool, Redis latency, S3 throughput, worker memory
7. **SLO Burn Rate** — current burn vs budget, projected exhaustion

Her dashboard'un JSON export'u repo'da; provisioning otomatik (Grafana ConfigMap).

## 13.3 Alerting

### 13.3.1 Alertmanager Rules

`infra/prometheus/alerts.yml`:

```yaml
groups:
- name: api
  rules:
  - alert: HighErrorRate
    expr: |
      (
        rate(gp_http_requests_total{status=~"5.."}[5m])
        /
        rate(gp_http_requests_total[5m])
      ) > 0.01
    for: 5m
    labels: { severity: warning, team: backend }
    annotations:
      summary: "5xx error rate > 1% for 5 minutes"
      runbook: https://github.com/gripati/gp/blob/main/docs/runbook/high-error-rate.md

  - alert: APIDownCritical
    expr: up{job="gp-web"} == 0
    for: 1m
    labels: { severity: critical, pagerduty: true }
    annotations:
      summary: "API is DOWN"
      runbook: https://github.com/gripati/gp/blob/main/docs/runbook/api-down.md

  - alert: SLOBurnRateFast
    expr: |
      (
        1 - (
          sum(rate(gp_http_requests_total{status!~"5.."}[1h]))
          / sum(rate(gp_http_requests_total[1h]))
        )
      ) > 0.02
    for: 5m
    labels: { severity: critical, pagerduty: true }
    annotations:
      summary: "SLO burning 2x normal rate (2% errors in 1h)"

- name: jobs
  rules:
  - alert: JobQueueBacklog
    expr: gp_jobs_in_progress > 100
    for: 10m
    labels: { severity: warning }
    annotations:
      summary: "100+ jobs in progress — workers not keeping up"

  - alert: JobFailureSpike
    expr: |
      rate(gp_jobs_total{status="failed"}[5m]) > 0.5
    for: 5m
    labels: { severity: warning }
    annotations:
      summary: "Job failure rate > 30/min"

- name: upstream
  rules:
  - alert: AppleIntegrationDown
    expr: |
      rate(gp_upstream_requests_total{provider="apple",status_class="5xx"}[5m]) > 0
      AND
      rate(gp_upstream_requests_total{provider="apple",status_class="2xx"}[5m]) == 0
    for: 3m
    labels: { severity: critical }
    annotations:
      summary: "All Apple API calls failing"

- name: infra
  rules:
  - alert: DatabaseConnectionsExhausted
    expr: gp_db_connections_active / 100 > 0.9   # 100 max pool
    for: 5m
    labels: { severity: warning }

  - alert: DiskSpaceLow
    expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.10
    for: 10m
    labels: { severity: warning }

- name: security
  rules:
  - alert: RLSViolationSpike
    expr: rate(gp_rls_violations_total[5m]) > 0.1
    for: 5m
    labels: { severity: critical, pagerduty: true, security: true }
    annotations:
      summary: "RLS policy denying access — possible tenant attack"
      runbook: https://github.com/gripati/gp/blob/main/docs/runbook/rls-violation.md

  - alert: AuthBruteForce
    expr: |
      rate(gp_auth_attempts_total{result="failure"}[5m]) > 1
    for: 10m
    labels: { severity: warning, security: true }
```

### 13.3.2 Notification Routing

**V1 self-host:** Email + (opsiyonel) Discord webhook
**V2 SaaS:** PagerDuty + Slack + Email

| Severity | V1 Channel | V2 Channel |
|----------|-----------|------------|
| `critical` | Email + Discord + (own phone via PagerDuty) | PagerDuty wake + Slack #incidents |
| `warning` | Email + Discord | Slack #alerts |
| `info` | Discord only | Slack #monitoring |

### 13.3.3 Alert Hygiene

- **Symptoms, not causes**: "API error rate high" değil "Login endpoint p99 > 2s"
- **Actionable**: her alert'in runbook linki olmalı
- **No flapping**: `for: 5m` minimum (10m tercih); 30s alert'ler ban
- **Auto-resolve**: koşul kaybolduktan 2m sonra resolve
- **Maintenance window**: deploy sırasında alert silent (annotation ile)

## 13.4 Runbook Catalog

Her alert için `docs/runbook/<alert-name>.md`. Çözüm adım adım.

### 13.4.1 Şablon

```markdown
# Runbook: High Error Rate

## Symptom
5xx errors > 1% of requests for >5 minutes.

## Impact
Users experiencing failures on `/api/v1/*` endpoints.

## Diagnosis
1. `kubectl logs -l app=gp-web --tail=100 | grep "ERROR"`  
   (V1 self-host: `docker compose logs web --tail 100`)
2. Check Grafana "API Overview" dashboard — hangi route?
3. Check upstream integration dashboard — Apple/Google down?
4. Check DB connection pool — exhausted?

## Common Causes
- Apple/Google upstream outage → wait, monitor their status pages
- DB pool exhaustion → scale workers or fix slow query
- OOM kill → check `kubectl describe pod` for memory limits
- Recent deploy regression → consider rollback

## Resolution
### If upstream outage:
- Activate maintenance banner: `kubectl apply -f infra/banner-upstream-outage.yaml`
- Status page incident: "Investigating upstream Apple/Google issues"
- Wait + monitor

### If our regression:
- Identify last deploy: `kubectl rollout history deployment/gp-web`
- Rollback: `kubectl rollout undo deployment/gp-web`
- Verify metrics recovery (5 min)
- Open issue in repo with root cause

### If DB pool exhausted:
- Scale workers down temporarily: `kubectl scale deployment gp-worker --replicas=1`
- Identify slow queries: connect to DB, `SELECT * FROM pg_stat_activity WHERE state='active' ORDER BY query_start;`
- Kill long-running query: `SELECT pg_cancel_backend(<pid>);`
- File issue for query optimization

## Post-Incident
- Update status page: "Resolved"
- Schedule blameless post-mortem within 48h
- Document root cause in `docs/incidents/YYYY-MM-DD-<slug>.md`
```

### 13.4.2 V1 Runbook Listesi (zorunlu)

- `api-down.md` — full outage
- `high-error-rate.md` — 5xx spike
- `slow-database.md` — DB latency, slow queries
- `redis-down.md` — cache/queue failure
- `disk-full.md` — storage space
- `apple-integration-fail.md` — credential expired, rate limit, outage
- `google-integration-fail.md` — same + edit session conflict
- `worker-stalled.md` — jobs stuck
- `rls-violation.md` — security incident, possible attack
- `credential-leak-suspected.md` — emergency response
- `database-restore.md` — disaster recovery
- `tenant-data-corruption.md` — repair single tenant
- `backup-failure.md` — daily backup didn't run
- `secret-manager-down.md` — credential fetch fail
- `deploy-rollback.md` — bad release recovery

## 13.5 Health Checks

Üç katman:

### 13.5.1 Liveness (`/api/v1/healthz`)

Sadece "process alive mi?" — restart kararı için (Kubernetes / Docker).

```ts
export async function GET() {
  return Response.json({ status: "alive", uptime: process.uptime() });
}
```

> Asla DB/Redis check etme — onlar fail olunca container restart'ı **işe yaramaz**, sadece restart loop'u yaratır.

### 13.5.2 Readiness (`/api/v1/readyz`)

"Yeni request'ler kabul edebilir miyim?" — load balancer routing kararı.

```ts
export async function GET() {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,                       // DB
    redis.ping(),                                     // Redis
    storage.healthCheck(),                            // S3/MinIO
    secrets.healthCheck(),                            // Secret manager
  ]);

  const results = {
    db: checks[0].status,
    redis: checks[1].status,
    storage: checks[2].status,
    secrets: checks[3].status,
  };
  const allOk = Object.values(results).every((s) => s === "fulfilled");

  return Response.json(
    { status: allOk ? "ready" : "not_ready", checks: results },
    { status: allOk ? 200 : 503 }
  );
}
```

### 13.5.3 Deep Health (`/api/v1/health/deep`, internal-only, auth required)

Tüm subsystem'lerin **detaylı** durumu (admin debug için):

```json
{
  "version": "1.5.0",
  "deployMode": "saas",
  "uptime": 86400,
  "checks": {
    "db": {
      "ok": true,
      "latencyMs": 3,
      "connectionPool": { "active": 8, "idle": 12, "max": 100 },
      "migration": "0042_add_subscriptions"
    },
    "redis": { "ok": true, "latencyMs": 1, "memory": "234MB / 2GB" },
    "queues": {
      "metadata-push": { "active": 2, "waiting": 5, "delayed": 0, "failed": 0 },
      "screenshot-upload": { "active": 12, "waiting": 0 }
    },
    "upstreams": {
      "apple": { "ok": true, "lastSuccessAt": "2026-05-17T14:22:01Z", "errors24h": 3 },
      "google": { "ok": true, "lastSuccessAt": "2026-05-17T14:23:18Z", "errors24h": 0 },
    },
    "storage": { "ok": true, "freeBytes": 184398848512 },
    "secrets": { "ok": true, "provider": "aws-sm" }
  }
}
```

## 13.6 Backup & Disaster Recovery

### 13.6.1 Backup Strategy

| Component | Frequency | Tool | Retention | Storage |
|-----------|-----------|------|-----------|---------|
| **Postgres** | Continuous WAL ship + daily full | WAL-G | 30d full + 7d WAL | S3 (cross-region) |
| **Object Store** | Versioning on (continuous) | S3 native | 90 days non-current versions | S3 same bucket |
| **Secrets** | On-change | AWS Secrets Manager built-in | unlimited | AWS managed |
| **Redis** | RDB snapshot hourly | redis-cli | 7d | S3 |
| **App config** | git-committed | git | forever | GitHub |

### 13.6.2 Restore Drill (Mandatory Monthly)

```
1. Spin up "staging-dr" environment
2. Restore Postgres from latest backup
3. Restore object store (selective: 1 random tenant's data)
4. Restore Redis
5. Smoke test:
   - Login as test user
   - Access tenant data — RLS works?
   - Trigger a metadata push (sandbox app) — works end-to-end?
6. Document time taken — should be < RTO (1 hour V1, 15 min SaaS)
7. Tear down staging-dr
```

Drill kalibrasyon raporu: `docs/dr-drills/YYYY-MM-DD.md`.

### 13.6.3 Disaster Scenarios

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Single container OOM | Kubernetes restart | Auto, no action |
| Entire VM lost | Health check fail | Provision new VM + restore from backup (V1) |
| DB corruption | Constraint violations cascade | Point-in-time recovery from WAL |
| Region outage (AWS us-east-1) | Multiple alerts | Failover to us-west-2 (V2.5 multi-region) |
| Ransomware on backup | Backup integrity check | Cross-region immutable backup |
| Accidental delete `DROP TABLE` | Audit log + missing data | PITR to t-5min |
| Credential leak | GuardDuty alert | Rotate all credentials, audit affected tenants |
| Tenant data corruption | Customer report | Single-tenant restore from backup |

## 13.7 Capacity Planning

### 13.7.1 V1 Self-Host (Single VM)

| Resource | Initial | Limit | Trigger to scale |
|----------|---------|-------|------------------|
| CPU | 4 vCPU | 8 vCPU | sustained > 70% for 1h |
| RAM | 8 GB | 16 GB | sustained > 75% |
| Disk | 100 GB | 500 GB | > 70% used |
| DB connections | 100 pool | 200 max | exhausted alarms |
| Redis memory | 1 GB | 2 GB | eviction starts |
| Workers | 2 | 5 | queue backlog > 50 |

### 13.7.2 V2 SaaS (Kubernetes)

| Resource | Initial | Scale rule |
|----------|---------|-----------|
| Web pods | 3 | HPA: CPU > 60% → +1 |
| Worker pods | 3 | HPA: queue depth > 30 → +1 |
| DB | db.m5.large + replica | manual upgrade when sustained > 70% CPU |
| Redis | t3.medium × 3 | manual upgrade when memory > 75% |
| S3 | unlimited | N/A |
| CDN bandwidth | Cloudflare unlimited Pro plan | N/A |

### 13.7.3 Per-Tenant Limits (rate limit + plan)

Bkz. `11_SELF_HOST_TO_SAAS.md` 11.4 — plan tier limit'leri zorunlu kılınır.

Ek olarak **per-tenant adaptive limits**:
- Tenant başına Apple API budget: 200 req/dakika (Apple'ın rate limit'ini koru)
- Tenant başına Google edit budget: 30 commit/saat (Google'ın limit'i)
- Tenant başına concurrent upload: 5

## 13.8 Performance Budget

### 13.8.1 Frontend

| Asset | Budget |
|-------|--------|
| Initial JS bundle | < 250 KB gzipped |
| Initial CSS | < 50 KB gzipped |
| Page transition JS | < 50 KB per route |
| First-load fonts | 2 weights only (Fraunces 400, Geist 400) |
| Largest image | < 200 KB (optimized webp) |
| Lighthouse Performance | > 90 |
| Lighthouse a11y | > 95 |
| Core Web Vitals | LCP < 2.5s, FID < 100ms, CLS < 0.1 |

Build-time check: `next-bundle-analyzer` + CI fail if budget aşılırsa.

### 13.8.2 Backend

| Endpoint | p99 budget | Notes |
|----------|------------|-------|
| `GET /me` | < 50ms | session lookup |
| `GET /apps` | < 200ms | tenant-scoped list |
| `GET /metadata` | < 300ms | 35 locale joined |
| `POST /metadata/push` | < 500ms (returns jobId) | actual push async |
| `POST /screenshots/upload` (sync part) | < 1000ms | validation + scratch save |
| `POST /auth/login` | < 200ms | Argon2 800ms intentional |

## 13.9 Chaos Engineering (V1.5+)

"Faults are unavoidable; design for them; rehearse them."

### 13.9.1 Quarterly Game Days

3 ayda bir, kontrollü chaos:

| Experiment | Hypothesis | Run |
|-----------|------------|-----|
| Kill 1 worker pod | Other workers pick up jobs, no data loss | `kubectl delete pod gp-worker-xxx` |
| Kill DB connection mid-transaction | Prisma retries, no partial write | `pg_terminate_backend(...)` on active conn |
| Inject 30s latency to Apple API | UI shows "Slow upstream" notice | toxiproxy or nginx_delay |
| 50% packet loss to Redis | Operations gracefully degrade | tc / netem |
| Fill disk to 95% | Alert fires, system continues critical ops | dd if=/dev/zero |
| Simulate AWS Secrets Manager down | App falls back to filesystem cache (V1.5) | network policy |
| Tenant A pushes 1000 metadata in 1 min | Other tenants unaffected (fair-share) | load test script |
| RLS policy "accidentally" disabled | Alert fires immediately | migration toggle in staging |

Output: `docs/chaos/YYYY-Q3-gameday.md` — what worked, what broke, what to fix.

### 13.9.2 Automated Chaos (Production, V2.5)

LitmusChaos / Chaos Monkey:
- Random worker pod kill every 3 days (business hours only, weekday)
- 50ms random latency injection on 1% of requests
- Random Redis key delete (cache poisoning test) on 0.1% of keys

Threshold: SLO must hold. If hold → chaos pass.

## 13.10 Observability Tooling Stack

| Concern | Tool | Notes |
|---------|------|-------|
| **Logs** | Pino → stdout → Loki (V1.5+) | Structured JSON, redacted |
| **Metrics** | Prometheus pull | `/metrics` endpoint per service |
| **Traces** | OpenTelemetry → Tempo (V1.5+) | Distributed tracing for cross-service requests |
| **Dashboards** | Grafana (self-host + Grafana Cloud free V2) | JSON provisioned |
| **Alerts** | Alertmanager → PagerDuty (V2) / Discord (V1) | Severity-routed |
| **Error tracking** | Sentry | Frontend + backend |
| **RUM** | Sentry Performance / Cloudflare Web Analytics | Real user timings |
| **Status page** | Cachet (self-host) / Statuspage (V2) | Public-facing |
| **Synthetic monitoring** | Checkly (V2) | Critical user journeys every 5 min |
| **Cost monitoring** | AWS Cost Explorer + Vantage (V2) | Tag-based per-tenant cost |

## 13.11 Deployment Strategy

### 13.11.1 V1 Self-Host

- GitHub Actions: build Docker image → push to ghcr.io
- Self-host: `docker compose pull && docker compose up -d`
- Database migration: Prisma `migrate deploy` runs as init-container before web starts
- Zero-downtime: 2 web replicas (V1.5 ile gelir; V1.0 tek replica, 30s downtime acceptable)

### 13.11.2 V2 SaaS

- GitHub Actions: build → push to ECR
- ArgoCD GitOps deployment (declarative)
- Strategy: **canary** (5% traffic for 10 min → 50% for 30 min → 100%)
- Auto-rollback on SLO burn rate spike
- Feature flags (LaunchDarkly / Flagsmith) for gradual rollout of new features

### 13.11.3 Database Migration Safety

```
1. PR includes migration SQL
2. CI: run migration on disposable DB, then run e2e tests
3. Migration runs forward-only (no rollback automation; manual data fix if needed)
4. NEVER drop column in same release as code changes; 2-step:
   - Release N: stop writing to column, deploy
   - Release N+1: drop column
```

## 13.12 Cost Observability

V2 SaaS için per-tenant cost tracking:

| Cost item | Tag |
|-----------|-----|
| S3 storage | `tenants/<id>/` prefix |
| S3 transfer | CloudFront distribution per tenant (V3) veya proportional |
| Secrets Manager | `tags: tenantId` |
| Postgres compute | shared (allocate proportional to query count) |
| Redis | shared (allocate proportional to key count) |
| Compute (EC2/EKS) | shared (allocate proportional to API request count) |

Dashboard "Top 10 expensive tenants" → enterprise upsell signal.

## 13.13 Incident Response

### 13.13.1 Severity Matrix

| Sev | Definition | Examples | Response |
|-----|-----------|----------|----------|
| **SEV1** | Complete service outage | API down, DB unreachable | Page on-call immediately, all-hands |
| **SEV2** | Major feature broken or > 25% users impacted | All Apple pushes failing, login broken for some | On-call + 1 backup; status page update in 15 min |
| **SEV3** | Single feature degraded | Slow uploads, 1 tenant affected | On-call investigates within 2h |
| **SEV4** | Cosmetic / minor | UI glitch, deprecated warning | Backlog ticket |

### 13.13.2 Incident Lifecycle

```
DETECT      → alert fires (auto) OR user reports
RESPOND     → on-call ack within 5 min (PagerDuty)
INVESTIGATE → assess severity, check runbook, gather data
COMMUNICATE → status page update; if SEV1/2, email customers
MITIGATE    → temporary fix (rollback, scale-up, kill switch)
RESOLVE     → root cause fixed, monitoring confirms
POST-MORTEM → 48h after, blameless write-up (template below)
```

### 13.13.3 Post-Mortem Template

`docs/incidents/YYYY-MM-DD-<slug>.md`:

```markdown
# Incident: <Brief title>

**Date:** 2026-05-17
**Duration:** 14:23 - 15:08 UTC (45 min)
**Severity:** SEV2
**Author:** @username

## Summary
One-paragraph description for executives.

## Timeline (UTC)
- 14:23 — first alert (high error rate)
- 14:25 — on-call ack
- 14:30 — identified Apple API returning 503
- 14:45 — activated maintenance banner
- 15:08 — Apple recovered, banner removed

## Impact
- ~30 tenants affected
- ~120 push attempts failed (auto-retried after recovery)
- No data loss

## Root Cause
Apple App Store Connect API was experiencing partial outage in us-east-1 region.

## What Went Well
- Detection in 2 min (alert fired automatically)
- Status page updated quickly
- Auto-retry worked perfectly when upstream recovered

## What Went Wrong
- No clear "upstream outage" UI in dashboard — users contacted support
- Status page update was manual; took 8 min

## Action Items
- [ ] Add "Apple is degraded" auto-banner when error rate > 5%
- [ ] Integrate Apple status page RSS into monitoring
- [ ] Status page incident automation (PagerDuty → Cachet)
- [ ] Add canary push (synthetic monitor) every 5 min for early detection

## Lessons
- Upstream dependencies need first-class observability
- Manual processes break under stress; automate everything
```

## 13.14 Maintenance & Operational Calendar

| Cadence | Activity |
|---------|----------|
| **Daily** | Review error budget, check overnight alerts |
| **Weekly** | Dependency update PR review (Dependabot), runbook accuracy check |
| **Monthly** | Restore drill, security scan review, capacity review |
| **Quarterly** | Chaos game day, SLO review (raise/lower targets?), pentest |
| **Yearly** | External security audit, full DR test (region failover), tech debt review |

Owned by: **YOU** for V1 self-host (kendi disiplinin); V2 SaaS gelir gelmez bir SRE rolü tanımla (kendin veya dış kontrak).

## 13.15 Documentation Tier

| Tier | Audience | Format | Update cadence |
|------|----------|--------|----------------|
| **Architecture** | Future contributors | This `/docs` folder | Per major change |
| **Runbooks** | On-call (sen) | `docs/runbook/*.md` | Per incident lesson |
| **ADRs** | Long-term context | `docs/adr/NNN-*.md` | Per major decision |
| **Post-mortems** | Learning | `docs/incidents/*.md` | Per incident |
| **API docs** | Customers (V2) | OpenAPI + redoc | Auto-generated on release |
| **User docs** | Customers | `docs.releaseflight.com` (V2) | Per feature |
| **Internal wiki** | (V2 team) | Notion / GitBook | Continuous |

## 13.16 V1 Stability Acceptance Criteria

V1.5 production-ready demek için:

- [ ] SLO dashboard yaşıyor (Grafana erişilir)
- [ ] 16 runbook yazılı + on-call training
- [ ] Backup günlük çalışıyor + ay 1 restore drill başarılı
- [ ] Alerting end-to-end test edildi (test alert PagerDuty'a ulaştı)
- [ ] 24 saat soak test geçti (sürekli yük, memory leak yok)
- [ ] Chaos game day 1 tamamlandı + bulgular düzeltildi
- [ ] Status page live
- [ ] Security pentest clean (HIGH+ findings YOK)
- [ ] Load test: 100 concurrent user × 5 dakika → SLO hold
- [ ] Restore drill < 1 saat RTO
- [ ] Documentation tier sıra ile dolu (architecture, runbook, ADR boş değil)

V2 SaaS production-ready demek için ek:

- [ ] PagerDuty + on-call rotation
- [ ] Status page automation
- [ ] Multi-region active-passive (V2.5)
- [ ] Quarterly external security audit
- [ ] Compliance docs (privacy policy, ToS, GDPR DPA template)
- [ ] Bug bounty program live (HackerOne / Bugcrowd)
- [ ] Annual penetration test
