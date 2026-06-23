"use client";

/**
 * Per-app ASO Daily Check panel.
 *
 * Three-section layout:
 *   1. Header — date picker + "Run check now" button + AI-verdict pill
 *   2. Analyst brief — headline, top-3 priorities, opportunities
 *   3. Alarm feed — every fired notification, with mark-read and the
 *      analyst's interpretation + probable cause + next action.
 */
import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@marquee/ui";
import { MoversPanel, type MoverRow } from "@/components/aso/MoversPanel";
import {
  AdoptedPerformanceWidget,
  type AdoptedVerdict,
} from "@/components/aso/AdoptedPerformanceWidget";

type Severity = "info" | "warning" | "danger";

export interface DailyCheckPageData {
  app: { id: string; appName: string; platform: string; bundleId: string };
  date: string;
  /** Top movers — pre-computed server-side from check.keywordDeltas
   *  so the panel doesn't need to re-parse the JSON column on every
   *  client render. */
  movers: {
    climbers: MoverRow[];
    decliners: MoverRow[];
    totals: {
      climbers: number;
      decliners: number;
      entered: number;
      exited: number;
      unchanged: number;
    };
  };
  /** Adopted-vs-default summary — feeds the swap-impact widget so
   *  the user can see whether their suggestion adoptions are
   *  outperforming the metadata defaults. */
  adopted: {
    adoptedTotal: number;
    defaultTotal: number;
    adoptedAvgRank: number | null;
    defaultAvgRank: number | null;
    rankDelta: number | null;
    verdict: AdoptedVerdict;
  };
  check: {
    id: string;
    status: string;
    metricsSnapshot: unknown;
    keywordDeltas: unknown;
    competitorMoves: unknown;
    alarmsTriggered: string[];
    analystReport: unknown;
    updatedAt: string;
  } | null;
  notifications: {
    id: string;
    severity: Severity;
    title: string;
    message: string;
    payload: unknown;
    trackedKeywordId: string | null;
    competitorId: string | null;
    agentInterpretation: string | null;
    agentProbableCause: string | null;
    agentNextAction: string | null;
    agentConfidence: number | null;
    readAt: string | null;
    createdAt: string;
  }[];
}

interface AnalystPriority {
  rank: number;
  action: string;
  rationale: string;
  expectedOutcome: string;
}

interface AnalystReport {
  headline: string;
  overallVerdict: "calm" | "watch" | "act" | "critical";
  top3Priorities: AnalystPriority[];
  opportunities: { title: string; description: string; kind: string }[];
  notes?: string;
}

interface MetricsSnapshot {
  pvcrPct?: number | string;
  impressions?: number;
  downloads?: number;
  firstTimeDownloads?: number;
}

interface DailyCheckPanelProps {
  tenantSlug: string;
  appId: string;
  initialDate: string;
  initialData: DailyCheckPageData;
}

export function DailyCheckPanel({
  tenantSlug,
  appId,
  initialDate,
  initialData,
}: DailyCheckPanelProps): JSX.Element {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState(initialData);
  const [running, setRunning] = useState(false);
  const [recentChanges, setRecentChanges] = useState("");
  const [pending, startTransition] = useTransition();

  const analyst = useMemo<AnalystReport | null>(() => {
    if (!data.check?.analystReport) return null;
    return data.check.analystReport as AnalystReport;
  }, [data]);

  const metrics = useMemo<MetricsSnapshot | null>(() => {
    if (!data.check?.metricsSnapshot) return null;
    return data.check.metricsSnapshot;
  }, [data]);

  const onChangeDate = useCallback(
    (next: string) => {
      setDate(next);
      startTransition(() => {
        router.replace(`/t/${tenantSlug}/apps/${appId}/pulse?date=${next}`);
      });
    },
    [router, tenantSlug, appId, startTransition],
  );

  const runCheck = useCallback(async () => {
    setRunning(true);
    try {
      const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
      const csrf = (await csrfRes.json()) as { csrfToken: string };
      const res = await fetch(`/api/v1/apps/${appId}/pulse-check`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
        body: JSON.stringify({
          date,
          ...(recentChanges.trim() ? { recentChanges: recentChanges.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        alert(`Daily check failed: ${err?.error?.message ?? `HTTP ${res.status.toString()}`}`);
        return;
      }
      // Re-fetch the page data after the check completes.
      const detail = await fetch(`/api/v1/apps/${appId}/pulse-check?date=${date}`, {
        credentials: "include",
      });
      if (detail.ok) {
        const fresh = (await detail.json()) as {
          date: string;
          check: DailyCheckPageData["check"];
          notifications: DailyCheckPageData["notifications"];
        };
        setData((prev) => ({ ...prev, ...fresh, app: prev.app }));
      } else {
        router.refresh();
      }
    } finally {
      setRunning(false);
    }
  }, [appId, date, recentChanges, router]);

  const markRead = useCallback(async (id: string) => {
    const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
    const csrf = (await csrfRes.json()) as { csrfToken: string };
    await fetch(`/api/v1/notifications/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
      body: JSON.stringify({ read: true }),
    });
    setData((prev) => ({
      ...prev,
      notifications: prev.notifications.map((n) =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
      ),
    }));
  }, []);

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end gap-4">
        <div>
          <div className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Daily Check
          </div>
          <h2 className="font-display mt-1 text-2xl">
            {data.app.appName}{" "}
            <span className="ml-2 font-mono text-xs text-[var(--ink-tertiary)]">
              {data.app.platform} · {data.app.bundleId}
            </span>
          </h2>
        </div>
        <div className="ml-auto flex items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-secondary)]">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => onChangeDate(e.target.value)}
              className="rounded-[var(--radius-xs)] border border-[var(--stroke-default)] bg-transparent px-2 py-1 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={runCheck}
            disabled={running || pending}
            className={cn(
              "rounded-[var(--radius-xs)] bg-[var(--ink-primary)] px-4 py-2 text-sm font-medium text-[var(--surface-paper)]",
              "hover:opacity-90 disabled:opacity-50",
            )}
          >
            {running ? "Running…" : "Run check now"}
          </button>
        </div>
      </section>

      {/* ── "What changed recently?" → analyst input ───────────── */}
      <section className="rounded-[var(--radius-sm)] border border-[var(--stroke-default)] p-4">
        <label className="block font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
          What changed yesterday? (helps the analyst attribute causes)
        </label>
        <textarea
          value={recentChanges}
          onChange={(e) => setRecentChanges(e.target.value)}
          rows={2}
          placeholder="e.g. pushed new screenshots in en-US, swapped 'merge' for 'puzzle' in subtitle"
          className="mt-2 w-full resize-none rounded-[var(--radius-xs)] border border-[var(--stroke-default)] bg-transparent px-3 py-2 font-mono text-[12px]"
        />
      </section>

      {/* ── Analyst brief ──────────────────────────────────────── */}
      {analyst ? <AnalystBrief report={analyst} /> : <NoAnalyst hasCheck={Boolean(data.check)} />}

      {/* ── Swap impact — adopted-vs-default avg rank comparison.
            Self-hides when both sides are empty. ── */}
      <AdoptedPerformanceWidget
        adoptedTotal={data.adopted.adoptedTotal}
        defaultTotal={data.adopted.defaultTotal}
        adoptedAvgRank={data.adopted.adoptedAvgRank}
        defaultAvgRank={data.adopted.defaultAvgRank}
        rankDelta={data.adopted.rankDelta}
        verdict={data.adopted.verdict}
      />

      {/* ── Today's movers — compact two-column view of every rank
            change, not just the alarm-worthy ones. Bridges the gap
            between the analyst's narrative and the numeric snapshot. ── */}
      <MoversPanel
        climbers={data.movers.climbers}
        decliners={data.movers.decliners}
        totals={data.movers.totals}
        tenantSlug={tenantSlug}
        appId={appId}
      />

      {/* ── Metrics snapshot ───────────────────────────────────── */}
      {metrics ? (
        <MetricStrip metrics={metrics} alarmKinds={data.check?.alarmsTriggered ?? []} />
      ) : null}

      {/* ── Alarm feed ─────────────────────────────────────────── */}
      <section>
        <h3 className="font-display mb-3 text-lg">
          Notifications{" "}
          <span className="ml-1 font-mono text-xs text-[var(--ink-tertiary)]">
            {data.notifications.length}
          </span>
        </h3>
        {data.notifications.length === 0 ? (
          <p className="text-sm text-[var(--ink-tertiary)]">
            No alarms fired on {date}. Either the check hasn't run yet (use Run check now) or
            everything's calm.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.notifications.map((n) => (
              <AlarmCard
                key={n.id}
                notification={n}
                tenantSlug={tenantSlug}
                appId={appId}
                onMarkRead={() => void markRead(n.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AnalystBrief({ report }: { report: AnalystReport }): JSX.Element {
  const verdictColour =
    report.overallVerdict === "critical"
      ? "bg-rose-500 text-white"
      : report.overallVerdict === "act"
        ? "bg-amber-500 text-white"
        : report.overallVerdict === "watch"
          ? "bg-sky-500 text-white"
          : "bg-emerald-500 text-white";

  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--stroke-default)] bg-[var(--surface-tinted)]/30 p-5">
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
            verdictColour,
          )}
        >
          {report.overallVerdict}
        </span>
        <div className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
          ASO Analyst brief
        </div>
      </div>
      <p className="font-display mt-2 text-lg leading-snug">{report.headline}</p>
      {report.top3Priorities.length > 0 ? (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Top priorities today
          </div>
          <ol className="mt-2 space-y-2">
            {report.top3Priorities.map((p) => (
              <li key={p.rank} className="flex gap-3">
                <span className="font-display text-xl text-[var(--ink-primary)]/40">
                  {p.rank.toString()}.
                </span>
                <div className="flex-1">
                  <div className="text-sm font-medium">{p.action}</div>
                  <div className="mt-0.5 text-xs text-[var(--ink-secondary)]">{p.rationale}</div>
                  <div className="mt-0.5 text-xs text-[var(--ink-tertiary)] italic">
                    Expected: {p.expectedOutcome}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {report.opportunities.length > 0 ? (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Opportunities
          </div>
          <ul className="mt-2 space-y-1">
            {report.opportunities.map((o, i) => (
              <li key={i} className="text-sm">
                <strong>{o.title}</strong>{" "}
                <span className="text-[var(--ink-secondary)]">— {o.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.notes ? (
        <p className="mt-3 text-xs text-[var(--ink-tertiary)] italic">{report.notes}</p>
      ) : null}
    </section>
  );
}

function NoAnalyst({ hasCheck }: { hasCheck: boolean }): JSX.Element {
  return (
    <section className="rounded-[var(--radius-sm)] border border-dashed border-[var(--stroke-default)] p-5 text-center">
      <p className="text-sm text-[var(--ink-secondary)]">
        {hasCheck
          ? "No analyst brief on file for this date — the AI either skipped (no alarms) or wasn't configured."
          : "No daily check on file. Click Run check now to generate one."}
      </p>
    </section>
  );
}

function MetricStrip({
  metrics,
  alarmKinds,
}: {
  metrics: MetricsSnapshot;
  alarmKinds: string[];
}): JSX.Element {
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Metric label="Impressions" value={metrics.impressions ?? null} />
      <Metric label="Downloads" value={metrics.downloads ?? null} />
      <Metric label="First-time DLs" value={metrics.firstTimeDownloads ?? null} />
      <Metric
        label="CVR %"
        value={metrics.pvcrPct != null ? Number(metrics.pvcrPct) : null}
        fmt="rate"
      />
      {alarmKinds.length > 0 ? (
        <div className="col-span-full mt-2 flex flex-wrap gap-2">
          {alarmKinds.map((k) => (
            <span
              key={k}
              className="rounded-full bg-[var(--surface-tinted)] px-2 py-1 font-mono text-[10px] text-[var(--ink-secondary)]"
            >
              {k}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  fmt = "int",
}: {
  label: string;
  value: number | null;
  fmt?: "int" | "rate";
}): JSX.Element {
  return (
    <div className="rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-3">
      <div className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        {label}
      </div>
      <div className="font-display mt-1 text-xl">
        {value == null
          ? "—"
          : fmt === "rate"
            ? `${value.toFixed(2)}%`
            : Math.round(value).toLocaleString()}
      </div>
    </div>
  );
}

function AlarmCard({
  notification,
  tenantSlug,
  appId,
  onMarkRead,
}: {
  notification: DailyCheckPageData["notifications"][number];
  tenantSlug: string;
  appId: string;
  onMarkRead: () => void;
}): JSX.Element {
  const unread = notification.readAt === null;
  const dot =
    notification.severity === "danger"
      ? "bg-rose-500"
      : notification.severity === "warning"
        ? "bg-amber-500"
        : "bg-sky-500";
  const href = notification.trackedKeywordId
    ? `/t/${tenantSlug}/apps/${appId}/keywords/${notification.trackedKeywordId}`
    : null;

  return (
    <li
      className={cn(
        "rounded-[var(--radius-sm)] border border-[var(--stroke-default)] p-4",
        unread ? "bg-[var(--surface-tinted)]/40" : "",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn("mt-1.5 inline-block h-2 w-2 flex-none rounded-full", dot)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {href ? (
              <Link href={href} className="font-medium hover:underline">
                {notification.title}
              </Link>
            ) : (
              <span className="font-medium">{notification.title}</span>
            )}
            <span className="ml-auto font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              {notification.severity}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
            {notification.agentInterpretation ?? notification.message}
          </p>
          {notification.agentProbableCause ? (
            <p className="mt-2 text-xs text-[var(--ink-tertiary)] italic">
              <strong className="text-[var(--ink-secondary)] not-italic">Probable cause:</strong>{" "}
              {notification.agentProbableCause}
            </p>
          ) : null}
          {notification.agentNextAction ? (
            <p className="mt-1 text-xs text-[var(--ink-secondary)]">
              <strong className="text-[var(--ink-primary)]">Next action:</strong>{" "}
              {notification.agentNextAction}
              {notification.agentConfidence != null ? (
                <span className="ml-2 font-mono text-[10px] text-[var(--ink-tertiary)]">
                  confidence {notification.agentConfidence.toString()}%
                </span>
              ) : null}
            </p>
          ) : null}
          {unread ? (
            <button
              type="button"
              onClick={onMarkRead}
              className="mt-3 text-xs text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
            >
              Mark as read
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
