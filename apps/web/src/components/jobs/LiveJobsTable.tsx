"use client";

/**
 * Live-updating Jobs table. Replaces the prior static server-rendered
 * table with a client component that:
 *
 *   • Polls `/api/v1/jobs` every 2 s while ANY job is in flight, and
 *     drops to 10 s when everything is stable (saves bandwidth +
 *     server load on idle dashboards).
 *   • Suspends polling while the tab is hidden (Page Visibility API),
 *     resumes + does one immediate refresh on return so the user
 *     doesn't see stale "Running" rows after a 20-minute break.
 *   • Renders progress bars + step text that update without a page
 *     reload — the user can SEE the worker churning through territory
 *     8/37 → 9/37 in real time.
 *   • Adds a Cancel (X) button for any QUEUED / RUNNING row. Clicking
 *     opens a ConfirmDialog; on confirm we POST `/jobs/[id]/cancel`,
 *     mark the row as "cancelling…" optimistically, and the next poll
 *     surfaces the real CANCELLED state.
 *
 * Initial data comes from the server (props.initialJobs) so the first
 * paint matches the page-shell SSR — no skeleton flash.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Divider, Spinner, Stamp, cn } from "@marquee/ui";
import { CircleDot, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

export interface JobSummary {
  id: string;
  kind: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "WAITING_RETRY";
  progress: { current: number; total: number; step: string | null };
  appId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Props {
  initialJobs: JobSummary[];
  pageSize: number;
}

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;

export function LiveJobsTable({ initialJobs, pageSize }: Props): JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>(initialJobs);
  // Per-row "cancellation in flight" so we can show a spinner on the
  // X button without flicker until the next poll confirms CANCELLED.
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<JobSummary | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Mounted flag so we can defer relative-time rendering — matches the
  // RelativeTime pattern used elsewhere in the app to avoid hydration
  // mismatches between server-rendered initial paint and the live
  // client clock.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Ref to the latest jobs so the polling callback always sees fresh
  // state without re-binding (avoids breaking the interval cadence).
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const anyInflight = useMemo(
    () => jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING"),
    [jobs],
  );

  // ── Poll loop ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async (): Promise<void> => {
      const res = await api<{ jobs: JobSummary[]; anyInflight: boolean }>(
        `/api/v1/jobs?limit=${pageSize.toString()}`,
      );
      if (cancelled) return;
      if (res.ok) {
        setJobs(res.data.jobs);
        // Clear cancelling spinners for any rows the server has moved
        // past in-flight (CANCELLED / FAILED / COMPLETED).
        setCancellingIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          for (const j of res.data.jobs) {
            if (j.status !== "QUEUED" && j.status !== "RUNNING") next.delete(j.id);
          }
          return next.size === prev.size ? prev : next;
        });
      }
    };

    const schedule = (): void => {
      if (cancelled) return;
      // Don't poll while the tab is hidden — wasted bandwidth and
      // would let the user open 20 tabs and DOS the server.
      if (typeof document !== "undefined" && document.hidden) return;
      const inflight = jobsRef.current.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
      const delay = inflight ? FAST_POLL_MS : SLOW_POLL_MS;
      timer = setTimeout(() => {
        void fetchOnce().then(() => schedule());
      }, delay);
    };

    const onVisibility = (): void => {
      if (cancelled) return;
      if (!document.hidden) {
        // Came back to the tab — refresh immediately + restart cadence.
        if (timer) clearTimeout(timer);
        void fetchOnce().then(() => schedule());
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    schedule();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [pageSize]);

  // ── Cancel flow ──────────────────────────────────────────────────
  const onConfirmCancel = useCallback(async (): Promise<void> => {
    if (!confirmTarget) return;
    setConfirmPending(true);
    const targetId = confirmTarget.id;
    const res = await api<{ cancelled: boolean; status: string }>(
      `/api/v1/jobs/${targetId}/cancel`,
      { method: "POST" },
    );
    setConfirmPending(false);
    setConfirmTarget(null);
    if (!res.ok) {
      toast.error("Could not cancel job", { description: res.message });
      return;
    }
    if (res.data.cancelled) {
      toast.success("Job cancelled");
      // Mark optimistically so the X turns into a spinner until the
      // next poll catches the real CANCELLED status.
      setCancellingIds((s) => new Set(s).add(targetId));
      setJobs((rows) =>
        rows.map((r) =>
          r.id === targetId
            ? {
                ...r,
                progress: {
                  ...r.progress,
                  step: "Cancelling…",
                },
              }
            : r,
        ),
      );
    } else {
      // Already terminal — gentle informational toast, no error.
      toast(`Job is already ${res.data.status.toLowerCase()}`);
    }
  }, [confirmTarget]);

  if (jobs.length === 0) {
    return (
      <Card className="p-10 text-center">
        <CircleDot className="mx-auto h-10 w-10 text-[var(--ink-tertiary)]" aria-hidden />
        <h3 className="font-display mt-4 text-[18px] text-[var(--ink-primary)]">No jobs yet</h3>
        <p className="font-body mt-2 text-[13px] text-[var(--ink-secondary)]">
          Push metadata or upload screenshots to see job activity here.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-warm)] px-4 py-2">
          <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            {anyInflight ? "Live · 2s refresh" : "Idle · 10s refresh"}
          </span>
          {anyInflight && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-[var(--signal)] uppercase">
              <Spinner className="h-2.5 w-2.5" />
              streaming
            </span>
          )}
        </div>
        <table className="w-full">
          <thead className="border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-warm)]">
            <tr className="text-left font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3 text-right">When</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                cancelling={cancellingIds.has(j.id)}
                onAskCancel={() => setConfirmTarget(j)}
                mounted={mounted}
              />
            ))}
          </tbody>
        </table>
        {jobs.length >= pageSize ? (
          <>
            <Divider />
            <div className="px-4 py-3 text-center font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
              Showing latest {pageSize.toString()} jobs
            </div>
          </>
        ) : null}
      </Card>

      <ConfirmDialog
        open={confirmTarget !== null}
        onClose={() => {
          if (!confirmPending) setConfirmTarget(null);
        }}
        onConfirm={onConfirmCancel}
        title={`Cancel ${confirmTarget?.kind ?? "job"}?`}
        description={
          confirmTarget ? (
            <div className="space-y-2">
              <p>
                This stops the running job. The worker finishes its current step (it may take a few
                seconds to unwind), then the row shows as <strong>cancelled</strong>. Any partial
                results already saved stay; nothing is rolled back.
              </p>
              <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">{confirmTarget.id}</p>
              {confirmTarget.progress.step && (
                <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                  Currently: {confirmTarget.progress.step}
                </p>
              )}
            </div>
          ) : null
        }
        confirmLabel={confirmPending ? "Cancelling…" : "Cancel job"}
        cancelLabel="Keep running"
        variant="destructive"
        pending={confirmPending}
      />
    </>
  );
}

// ── Row component ────────────────────────────────────────────────────

function JobRow({
  job,
  cancelling,
  onAskCancel,
  mounted,
}: {
  job: JobSummary;
  cancelling: boolean;
  onAskCancel: () => void;
  mounted: boolean;
}): JSX.Element {
  const inflight = job.status === "QUEUED" || job.status === "RUNNING";
  const pct =
    job.progress.total > 0
      ? Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))
      : 0;

  return (
    <tr
      className={cn(
        "border-b-[0.5px] border-[var(--stroke-default)] last:border-b-0",
        inflight && "bg-[var(--surface-tinted)]",
      )}
    >
      <td className="px-4 py-3 font-mono text-[12px] text-[var(--ink-primary)]">{job.kind}</td>
      <td className="px-4 py-3">
        <Stamp variant={statusVariant(job.status)}>{job.status.toLowerCase()}</Stamp>
      </td>
      <td className="px-4 py-3 align-top font-mono text-[11px] text-[var(--ink-secondary)]">
        <div className="flex items-center gap-2">
          <span className="tabular-nums">
            {pct.toString()}% · {job.progress.current.toString()}/{job.progress.total.toString()}
          </span>
          {job.progress.step && (
            <span className="truncate text-[var(--ink-tertiary)]">{job.progress.step}</span>
          )}
        </div>
        {inflight && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-tinted)]">
            <div
              className="h-full bg-[var(--signal)] transition-[width] duration-500 ease-out"
              style={{ width: `${pct.toString()}%` }}
            />
          </div>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-[var(--ink-tertiary)]">
        <span suppressHydrationWarning>
          {job.startedAt
            ? mounted
              ? relativeTime(job.startedAt)
              : job.startedAt.slice(11, 19)
            : "—"}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-[11px] text-[var(--ink-tertiary)]">
        <span suppressHydrationWarning>
          {mounted ? relativeTime(job.createdAt) : job.createdAt.slice(11, 19)}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        {inflight ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onAskCancel}
            disabled={cancelling}
            title="Cancel this job"
            className="text-[var(--status-danger)]"
          >
            {cancelling ? <Spinner className="h-3 w-3" /> : <X size={12} />}
            <span className="ml-1">{cancelling ? "Cancelling…" : "Cancel"}</span>
          </Button>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.06em] text-[var(--ink-tertiary)] uppercase">
            —
          </span>
        )}
      </td>
    </tr>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function statusVariant(status: string): "success" | "warning" | "danger" | "default" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "RUNNING" || status === "QUEUED" || status === "WAITING_RETRY") return "warning";
  return "default";
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = Date.now() - t;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec.toString()}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60).toString()}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600).toString()}h ago`;
  return `${Math.round(sec / 86_400).toString()}d ago`;
}
