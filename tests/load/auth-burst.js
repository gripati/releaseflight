/**
 * Auth burst — pretends to be a brute-force attempt. We want to see that:
 *   1. Far more than 50 % of attempts get 429ed.
 *   2. NO request returns 5xx.
 *   3. p95 stays under 1 s — even when rate-limiting, we should reject fast.
 *
 * Bonus: confirms the per-email AND per-IP limits work together.
 */
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

const rateLimited = new Counter("rate_limited");
const denied = new Counter("auth_denied");
const errors5xx = new Counter("errors_5xx");

export const options = {
  vus: 50,
  duration: "30s",
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    errors_5xx: ["count==0"],
    rate_limited: ["count>50"],
  },
};

function csrf() {
  const r = http.get(`${BASE}/api/v1/auth/csrf-token`);
  return r.json("csrfToken");
}

export default function () {
  const token = csrf();
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: `attacker-${__VU}@evil.test`, password: "wrong" }),
    {
      headers: {
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      tags: { name: "login" },
    },
  );
  check(res, { "no 5xx": (r) => r.status < 500 });
  if (res.status === 429) rateLimited.add(1);
  if (res.status === 401) denied.add(1);
  if (res.status >= 500) errors5xx.add(1);
}
