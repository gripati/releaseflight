/**
 * Baseline soak — 5 minutes of light constant traffic against the public
 * surface. We use this as the canary load to ensure nothing has regressed
 * to a "smells slow" state. Targets:
 *
 *   - p95 latency under 500 ms (SLO_TARGETS.api_latency_p99 is 500ms; p95 < p99)
 *   - error rate ≤ 0.5 %
 *
 * Output is human-readable + JSON. CI parses the JSON to fail the build
 * if thresholds slip.
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    constant_low: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 30,
      maxVUs: 80,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1500"],
    http_req_failed: ["rate<0.005"],
    checks: ["rate>0.99"],
  },
};

const ROUTES = [
  "/api/v1/healthz",
  "/api/v1/readyz",
  "/api/v1/status",
  "/login",
];

export default function () {
  const path = ROUTES[Math.floor(Math.random() * ROUTES.length)];
  const res = http.get(`${BASE}${path}`, {
    tags: { name: path },
  });
  check(res, {
    "status is 2xx/3xx/4xx (no 5xx)": (r) => r.status < 500,
  });
  sleep(0.1);
}
