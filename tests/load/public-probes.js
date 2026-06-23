/**
 * Public-probe burst — synthetic monitors hammer healthz / status / readyz
 * every few seconds in production. They MUST stay sub-100 ms p99 under
 * realistic load. Catches DB connection-pool exhaustion early.
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    probes_burst: {
      executor: "ramping-arrival-rate",
      startRate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 80,
      maxVUs: 200,
      stages: [
        { target: 200, duration: "30s" },
        { target: 200, duration: "1m" },
        { target: 0, duration: "10s" },
      ],
    },
  },
  thresholds: {
    "http_req_duration{name:healthz}": ["p(95)<50", "p(99)<100"],
    "http_req_duration{name:readyz}": ["p(95)<100", "p(99)<200"],
    "http_req_duration{name:status}": ["p(95)<200", "p(99)<500"],
    http_req_failed: ["rate<0.001"],
  },
};

export default function () {
  http.get(`${BASE}/api/v1/healthz`, { tags: { name: "healthz" } });
  const r = http.get(`${BASE}/api/v1/readyz`, { tags: { name: "readyz" } });
  check(r, { "readyz < 200": (x) => x.status < 500 });
  http.get(`${BASE}/api/v1/status`, { tags: { name: "status" } });
}
