import {
  httpDuration,
  httpRequests,
  jobDuration,
  jobsInProgress,
  jobsTotal,
  upstreamDuration,
  upstreamRequests,
} from "./metrics";

/** Lower-cardinality status class — keeps the histogram dimensions manageable. */
function statusClass(status: number): string {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

export function observeHttp(method: string, route: string, status: number, durationSeconds: number): void {
  const labels = { method, route, status: status.toString() };
  httpRequests.inc(labels);
  httpDuration.observe(labels, durationSeconds);
}

export function observeUpstream(
  provider: "apple" | "google",
  endpoint: string,
  status: number,
  durationSeconds: number,
): void {
  upstreamRequests.inc({ provider, endpoint, status_class: statusClass(status) });
  upstreamDuration.observe({ provider, endpoint }, durationSeconds);
}

export function observeJob<T>(
  queue: string,
  fn: () => Promise<T>,
): Promise<T> {
  jobsInProgress.inc({ queue });
  const end = jobDuration.startTimer({ queue });
  return fn().then(
    (result) => {
      jobsInProgress.dec({ queue });
      jobsTotal.inc({ queue, status: "completed" });
      end();
      return result;
    },
    (err: unknown) => {
      jobsInProgress.dec({ queue });
      jobsTotal.inc({ queue, status: "failed" });
      end();
      throw err;
    },
  );
}
