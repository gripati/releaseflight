import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus registry singleton. Defaults (process CPU, event-loop lag,
 * heap, …) are collected automatically. Custom Release Flight metrics
 * follow the `gp_` prefix convention so they're easy to filter against
 * platform-level node metrics.
 */
const globalKey = "__gp_prom_registry__";
const g = globalThis as unknown as Record<string, Registry | undefined>;
export const registry: Registry = g[globalKey] ?? new Registry();
if (!g[globalKey]) {
  collectDefaultMetrics({ register: registry, prefix: "gp_node_" });
  g[globalKey] = registry;
}

// ────────────────────────────────────────────────────────────────────
// HTTP layer
// ────────────────────────────────────────────────────────────────────

export const httpRequests = new Counter({
  name: "gp_http_requests_total",
  help: "Total HTTP requests served",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: "gp_http_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// ────────────────────────────────────────────────────────────────────
// Upstream API layer (Apple / Google)
// ────────────────────────────────────────────────────────────────────

export const upstreamRequests = new Counter({
  name: "gp_upstream_requests_total",
  help: "Upstream API calls",
  labelNames: ["provider", "endpoint", "status_class"] as const,
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: "gp_upstream_duration_seconds",
  help: "Upstream API call duration",
  labelNames: ["provider", "endpoint"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

// ────────────────────────────────────────────────────────────────────
// Background jobs
// ────────────────────────────────────────────────────────────────────

export const jobsTotal = new Counter({
  name: "gp_jobs_total",
  help: "Background jobs processed",
  labelNames: ["queue", "status"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "gp_job_duration_seconds",
  help: "Job processing duration",
  labelNames: ["queue"] as const,
  buckets: [1, 5, 10, 30, 60, 300, 900, 1800, 3600],
  registers: [registry],
});

export const jobsInProgress = new Gauge({
  name: "gp_jobs_in_progress",
  help: "Currently running jobs",
  labelNames: ["queue"] as const,
  registers: [registry],
});

// ────────────────────────────────────────────────────────────────────
// Security / auth / tenant
// ────────────────────────────────────────────────────────────────────

export const authAttempts = new Counter({
  name: "gp_auth_attempts_total",
  help: "Login attempts",
  labelNames: ["result"] as const, // success | failure | rate_limited
  registers: [registry],
});

export const rlsViolationAttempts = new Counter({
  name: "gp_rls_violations_total",
  help:
    "Number of times Postgres RLS denied a query — high values indicate either a code bug or an attacker probing for cross-tenant access",
  labelNames: ["table"] as const,
  registers: [registry],
});

export const tenantsActiveDaily = new Gauge({
  name: "gp_tenants_active_daily",
  help: "Tenants with at least one request in the last 24h",
  registers: [registry],
});

export const usagePushes = new Counter({
  name: "gp_usage_pushes_total",
  help: "Metadata pushes (used for billing + SLO)",
  labelNames: ["platform"] as const,
  registers: [registry],
});

// ────────────────────────────────────────────────────────────────────
// Infrastructure
// ────────────────────────────────────────────────────────────────────

export const dbConnectionsActive = new Gauge({
  name: "gp_db_connections_active",
  help: "Active Prisma DB connections (sampled)",
  registers: [registry],
});

export const redisLatency = new Histogram({
  name: "gp_redis_latency_seconds",
  help: "Redis command latency",
  labelNames: ["command"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [registry],
});

export const storageBytesUploaded = new Counter({
  name: "gp_storage_bytes_uploaded_total",
  help: "Bytes uploaded to object storage",
  labelNames: ["kind"] as const, // screenshot | preview | aab | thumbnail
  registers: [registry],
});

export const uploadedScreenshots = new Counter({
  name: "gp_screenshots_uploaded_total",
  help: "Screenshots uploaded to upstream stores",
  labelNames: ["platform", "outcome"] as const,
  registers: [registry],
});

// ────────────────────────────────────────────────────────────────────
// Exposition
// ────────────────────────────────────────────────────────────────────

export async function metricsHandler(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
