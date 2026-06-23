/**
 * SLO targets — source of truth used by the /status endpoint, runbook
 * alerts and the README badges. Numbers come from docs/13_STABILITY_OPS.md.
 */

export interface SloTarget {
  id: string;
  description: string;
  /** Monthly target, e.g. 0.99 = 99 %. */
  target: number;
  unit: "ratio" | "ms" | "minutes" | "hours" | "days";
}

export const SLO_TARGETS: Record<string, SloTarget> = {
  api_availability: {
    id: "api_availability",
    description: "API availability — successful 2xx/3xx/4xx-client / total",
    target: 0.99,
    unit: "ratio",
  },
  api_latency_p99: {
    id: "api_latency_p99",
    description: "API request p99 latency",
    target: 500,
    unit: "ms",
  },
  push_success: {
    id: "push_success",
    description: "Metadata push success rate (excluding upstream Apple/Google failures)",
    target: 0.99,
    unit: "ratio",
  },
  job_completion_p99: {
    id: "job_completion_p99",
    description: "metadata.push job p99 completion time",
    target: 300_000,
    unit: "ms",
  },
  rpo: {
    id: "rpo",
    description: "Recovery point objective (data loss window)",
    target: 5,
    unit: "minutes",
  },
  rto: {
    id: "rto",
    description: "Recovery time objective (restore-to-service)",
    target: 60,
    unit: "minutes",
  },
  data_durability: {
    id: "data_durability",
    description: "Object-store durability (S3 native SLA passed through)",
    target: 0.999_999_999,
    unit: "ratio",
  },
};
