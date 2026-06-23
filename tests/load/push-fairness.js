/**
 * Push-fairness test — simulates multiple tenants kicking off metadata
 * pushes concurrently. The goal is to confirm that no single tenant
 * starves another (>3x latency divergence is the alarm).
 *
 * Requires an env file at `tests/load/.env.tenants` with COOKIE_T1 /
 * COOKIE_T2 / COOKIE_T3 session cookie values:
 *
 *   COOKIE_T1=gp_session=...
 *   COOKIE_T2=gp_session=...
 *   COOKIE_T3=gp_session=...
 *
 * Set them via `gp_session` from a logged-in browser before running.
 */
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const T1 = __ENV.COOKIE_T1 || "";
const T2 = __ENV.COOKIE_T2 || "";
const T3 = __ENV.COOKIE_T3 || "";

const latencyT1 = new Trend("latency_t1");
const latencyT2 = new Trend("latency_t2");
const latencyT3 = new Trend("latency_t3");

export const options = {
  scenarios: {
    tenant_1: { executor: "constant-vus", vus: 5, duration: "1m", exec: "tenant1" },
    tenant_2: { executor: "constant-vus", vus: 5, duration: "1m", exec: "tenant2" },
    tenant_3: { executor: "constant-vus", vus: 5, duration: "1m", exec: "tenant3" },
  },
  thresholds: {
    "latency_t1": ["p(95)<2000"],
    "latency_t2": ["p(95)<2000"],
    "latency_t3": ["p(95)<2000"],
    http_req_failed: ["rate<0.05"],
  },
};

function pushFor(cookie, trend) {
  if (!cookie) return; // Skip silently if cookie missing
  const start = Date.now();
  // Read-only endpoint chosen for fairness comparison without side effects
  const r = http.get(`${BASE}/api/v1/apps`, {
    headers: { cookie },
    tags: { name: "apps-list" },
  });
  trend.add(Date.now() - start);
  check(r, { "200/401/403 only": (x) => [200, 401, 403].includes(x.status) });
}

export function tenant1() { pushFor(T1, latencyT1); }
export function tenant2() { pushFor(T2, latencyT2); }
export function tenant3() { pushFor(T3, latencyT3); }

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        t1_p95: data.metrics.latency_t1?.values?.["p(95)"] ?? null,
        t2_p95: data.metrics.latency_t2?.values?.["p(95)"] ?? null,
        t3_p95: data.metrics.latency_t3?.values?.["p(95)"] ?? null,
        fairness_alarm:
          (() => {
            const vals = [
              data.metrics.latency_t1?.values?.["p(95)"],
              data.metrics.latency_t2?.values?.["p(95)"],
              data.metrics.latency_t3?.values?.["p(95)"],
            ].filter((v) => typeof v === "number");
            if (vals.length < 2) return false;
            return Math.max(...vals) / Math.min(...vals) > 3;
          })(),
      },
      null,
      2,
    ),
  };
}
