"use client";

/**
 * Pulse — daily-health landing surface (modern visual refresh).
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ✦  TODAY · 21 May 2026                              [Watch]      │
 *   │ Downloads up 18% week-over-week, driven by 'puzzle saga'…       │
 *   │ ┌──────────┐ ┌──────────┐ ┌──────────┐                          │
 *   │ │ 1 …      │ │ 2 …      │ │ 3 …      │   3 priority actions     │
 *   │ └──────────┘ └──────────┘ └──────────┘                          │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
 *   │ │ 2,847    │ │ 4.8%     │ │ 41.2K    │ │ 18.4K    │             │
 *   │ │ ↑ 18% ▲  │ │ →  0pp   │ │ ↑ 22% ▲  │ │ ↑ 6%  ▲  │             │
 *   │ └──────────┘ └──────────┘ └──────────┘ └──────────┘             │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Today's movers              │  Alarms                            │
 *   │ ▲ puzzle saga  US  42→12    │  ● 2 keywords dropped >10 ranks    │
 *   │ ▲ block crash  GB  18→9     │  ◐ Apple analytics ramp-up: 1d     │
 *   │ ▼ match colors DE  5→19     │                                    │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Refresh notes:
 *   • Drops the mono-uppercase labels — sans throughout.
 *   • KPI numbers go from `text-[28px]` to `text-[36px]` — they're the
 *     hero metric, they should dominate.
 *   • Delta arrows live in status-tinted rounded pills so success / loss
 *     register at a glance without dragging the whole card into colour.
 *   • The AI brief becomes a hero card with a tinted left accent stripe
 *     in the verdict colour.
 *   • Movers + alarms move to a left/right split with tighter row
 *     density and avatar-style status dots.
 */
import Link from "next/link";
import { useMemo } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  ArrowRight,
  Bell,
  Sparkles,
  Clock,
  AlertCircle,
  AlertTriangle,
  Info,
} from "lucide-react";
import { Stamp, cn } from "@marquee/ui";
import type { DashboardData } from "./Overview";
import type { MoverRow } from "./MoversPanel";
import { PulseDateFilter, type RangeToken } from "./PulseDateFilter";

// ──────────────────────────────────────────────────────────────────────
// Data shape
// ──────────────────────────────────────────────────────────────────────

type Severity = "info" | "warning" | "danger";

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
  opportunities?: { title: string; description: string; kind: string }[];
  notes?: string;
}

export interface PulseAlarm {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  trackedKeywordId: string | null;
  createdAt: string;
}

export interface PulseData {
  dashboard: DashboardData;
  daily: {
    date: string;
    analystReport: AnalystReport | null;
    movers: { climbers: MoverRow[]; decliners: MoverRow[] };
    alarms: PulseAlarm[];
  } | null;
}

interface Props {
  tenantSlug: string;
  appId: string;
  data: PulseData;
  /** Current trend window — drives KPI deltas. Mirrors `?range=`. */
  range: RangeToken;
  /** Selected day — drives analyst brief / movers / alarms. ISO YYYY-MM-DD. */
  date: string;
}

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function PulseSurface({
  tenantSlug,
  appId,
  data,
  range,
  date,
}: Props): JSX.Element {
  const { dashboard, daily } = data;
  const totals = dashboard.totals;
  const delta = dashboard.delta;

  return (
    <div className="space-y-6">
      {/* ── Date + range filter ─────────────────────────────────────
       *  Sits above every other Pulse element so the operator's first
       *  scan answers "what window am I looking at?". The whole surface
       *  re-fetches via URL change when either control moves. */}
      <PulseDateFilter
        tenantSlug={tenantSlug}
        appId={appId}
        range={range}
        date={date}
      />

      {/* ── AI brief hero ──────────────────────────────────────────── */}
      {daily?.analystReport ? (
        <AnalystBrief
          report={daily.analystReport}
          date={daily.date}
          tenantSlug={tenantSlug}
          appId={appId}
        />
      ) : (
        <BriefEmptyState />
      )}

      {/* ── KPI grid ───────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile
          label="App units"
          value={formatCompact(totals.downloads)}
          delta={delta.downloads}
          deltaSuffix="%"
          sublabel={`${formatCompact(totals.firstTimeDownloads)} first-time`}
        />
        <KpiTile
          label="Conversion"
          value={`${totals.pvcrPct.toFixed(2)}%`}
          delta={delta.pvcrPctPoints}
          deltaSuffix="pp"
          isPercentPoints
          sublabel="Page views → installs"
        />
        <KpiTile
          label="Impressions"
          value={formatCompact(totals.impressions)}
          delta={delta.impressions}
          deltaSuffix="%"
          sublabel="Search + browse"
        />
        <KpiTile
          label="Page views"
          value={formatCompact(totals.pageViews)}
          delta={delta.pageViews}
          deltaSuffix="%"
          sublabel="Product page"
        />
      </section>

      {/* ── Movers + alarms split ──────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <MoversCard
          tenantSlug={tenantSlug}
          appId={appId}
          climbers={daily?.movers.climbers ?? []}
          decliners={daily?.movers.decliners ?? []}
        />
        <AlarmsCard
          tenantSlug={tenantSlug}
          appId={appId}
          alarms={daily?.alarms ?? []}
        />
      </section>

      {/* ── Footer meta line ─────────────────────────────────────────
       *  The previous "Range 7d · …" prefix was dropped — the date+
       *  range filter at the top of the surface already exposes that
       *  state with full edit affordance, so echoing it down here was
       *  pure duplication. */}
      <p className="flex items-center gap-1.5 pt-2 text-[12px] text-[var(--ink-tertiary)]">
        <Clock size={12} />
        {dashboard.app.activeLocales.toString()} locale
        {dashboard.app.activeLocales === 1 ? "" : "s"}
        <span aria-hidden className="px-1 text-[var(--ink-quaternary)]">·</span>
        {dashboard.keywords.totalTracked.toString()} tracked keywords
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Analyst brief hero
// ──────────────────────────────────────────────────────────────────────

const VERDICT_META: Record<
  AnalystReport["overallVerdict"],
  { label: string; tone: "default" | "success" | "warning" | "danger" | "info"; stripe: string }
> = {
  calm: { label: "Calm", tone: "success", stripe: "var(--status-success)" },
  watch: { label: "Watch", tone: "info", stripe: "var(--status-info)" },
  act: { label: "Act", tone: "warning", stripe: "var(--status-warning)" },
  critical: { label: "Critical", tone: "danger", stripe: "var(--status-danger)" },
};

function AnalystBrief({
  report,
  date,
}: {
  report: AnalystReport;
  date: string;
  tenantSlug: string;
  appId: string;
}): JSX.Element {
  const verdict = VERDICT_META[report.overallVerdict];
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-6">
      {/* Vertical accent stripe in verdict colour */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: verdict.stripe }}
      />
      <div className="pl-3">
        <div className="mb-3 flex items-center gap-2">
          <span
            aria-hidden
            className="grid h-6 w-6 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-secondary)]"
          >
            <Sparkles size={12} />
          </span>
          <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
            Today
          </span>
          <span aria-hidden className="text-[var(--ink-quaternary)]">·</span>
          <span className="text-[12px] text-[var(--ink-tertiary)]">
            {formatDate(date)}
          </span>
          <Stamp variant={verdict.tone}>{verdict.label}</Stamp>
        </div>

        <h2
          className="font-display text-[24px] leading-tight tracking-[-0.01em] text-[var(--ink-primary)]"
          style={{ fontVariationSettings: "'wght' 600" }}
        >
          {report.headline}
        </h2>

        {report.top3Priorities.length > 0 && (
          <ol className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
            {report.top3Priorities.slice(0, 3).map((p) => (
              <li
                key={p.rank}
                className="rounded-[var(--radius-md)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] p-3"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="grid h-5 w-5 place-items-center rounded-full bg-[var(--ink-primary)] text-[11px] font-semibold tabular-nums text-[var(--surface-elevated)]"
                  >
                    {p.rank.toString()}
                  </span>
                  <span className="text-[13px] font-semibold leading-tight text-[var(--ink-primary)]">
                    {p.action}
                  </span>
                </div>
                <p className="line-clamp-2 text-[12px] leading-snug text-[var(--ink-secondary)]">
                  {p.rationale}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function BriefEmptyState(): JSX.Element {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-sunken)] text-[var(--ink-tertiary)]">
          <Sparkles size={16} />
        </span>
        <div>
          <h2
            className="font-display text-[20px] tracking-[-0.005em] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            No daily check has run today
          </h2>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-[var(--ink-secondary)]">
            Daily checks run automatically at 06:00 UTC after Astro mining
            completes. Hit Sync in the header to run one now.
          </p>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// KPI tile
// ──────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  delta,
  deltaSuffix,
  isPercentPoints,
  sublabel,
}: {
  label: string;
  value: string;
  delta: number | null;
  deltaSuffix: string;
  isPercentPoints?: boolean;
  sublabel?: string;
}): JSX.Element {
  const direction =
    delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const Icon =
    direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;

  let deltaLabel: string;
  if (delta == null) {
    deltaLabel = "—";
  } else if (isPercentPoints) {
    deltaLabel = `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${deltaSuffix}`;
  } else {
    deltaLabel = `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}${deltaSuffix}`;
  }

  // Tinted pill in success / danger / neutral — easier to scan than
  // bare-coloured text against the card background.
  const pillTint =
    direction === "up"
      ? "var(--status-success-tint)"
      : direction === "down"
        ? "var(--status-danger-tint)"
        : "var(--surface-sunken)";
  const pillFg =
    direction === "up"
      ? "var(--status-success)"
      : direction === "down"
        ? "var(--status-danger)"
        : "var(--ink-tertiary)";

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-5">
      <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
        {label}
      </span>
      <span
        className="font-display text-[36px] tabular-nums leading-none text-[var(--ink-primary)]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        {value}
      </span>
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-semibold tabular-nums"
          style={{ background: pillTint, color: pillFg }}
        >
          <Icon size={12} />
          {deltaLabel}
        </span>
        {sublabel && (
          <span className="truncate text-[11px] text-[var(--ink-tertiary)]">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Movers card
// ──────────────────────────────────────────────────────────────────────

function MoversCard({
  tenantSlug,
  appId,
  climbers,
  decliners,
}: {
  tenantSlug: string;
  appId: string;
  climbers: MoverRow[];
  decliners: MoverRow[];
}): JSX.Element {
  const isEmpty = climbers.length === 0 && decliners.length === 0;
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-5">
      <header className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
          Today&apos;s movers
        </h3>
        <Link
          href={`/t/${tenantSlug}/apps/${appId}/keywords/history`}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--signal)] hover:text-[var(--signal-hover)]"
        >
          See all
          <ArrowRight size={11} />
        </Link>
      </header>
      {isEmpty ? (
        <p className="text-[13px] text-[var(--ink-tertiary)]">
          No keyword rank changes today.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <MoverColumn
            tenantSlug={tenantSlug}
            appId={appId}
            rows={climbers.slice(0, 5)}
            direction="up"
          />
          <MoverColumn
            tenantSlug={tenantSlug}
            appId={appId}
            rows={decliners.slice(0, 5)}
            direction="down"
          />
        </div>
      )}
    </div>
  );
}

function MoverColumn({
  tenantSlug,
  appId,
  rows,
  direction,
}: {
  tenantSlug: string;
  appId: string;
  rows: MoverRow[];
  direction: "up" | "down";
}): JSX.Element {
  const Icon = direction === "up" ? TrendingUp : TrendingDown;
  const tint =
    direction === "up" ? "var(--status-success)" : "var(--status-danger)";
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="grid h-5 w-5 place-items-center rounded-full"
          style={{ background: `${tint}1a`, color: tint }}
        >
          <Icon size={11} />
        </span>
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-secondary)]">
          {direction === "up" ? "Climbers" : "Decliners"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--ink-tertiary)]">none</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.trackedKeywordId}>
              <Link
                href={`/t/${tenantSlug}/apps/${appId}/keywords/${r.trackedKeywordId}`}
                className="group grid grid-cols-[1fr_auto] items-center gap-3 rounded-[var(--radius)] px-2 py-1.5 transition-colors hover:bg-[var(--surface-tinted)]"
              >
                <div className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-[var(--ink-primary)] group-hover:text-[var(--ink-primary)]">
                    {r.keyword}
                  </span>
                  <span className="text-[11px] text-[var(--ink-tertiary)]">
                    {r.territory}
                  </span>
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                  style={{
                    background: `${tint}1a`,
                    color: tint,
                  }}
                >
                  {r.rankYesterday ?? "—"} → {r.rankToday ?? "—"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Alarms card
// ──────────────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<Severity, typeof AlertCircle> = {
  danger: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};
const SEVERITY_COLOR: Record<Severity, string> = {
  danger: "var(--status-danger)",
  warning: "var(--status-warning)",
  info: "var(--status-info)",
};

function AlarmsCard({
  alarms,
  tenantSlug,
  appId,
}: {
  alarms: PulseAlarm[];
  tenantSlug: string;
  appId: string;
}): JSX.Element {
  const sorted = useMemo(
    () =>
      [...alarms].sort((a, b) => {
        const order: Record<Severity, number> = { danger: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      }),
    [alarms],
  );
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-5">
      <header className="mb-4 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
          Alarms
        </h3>
        <span className="text-[12px] text-[var(--ink-tertiary)]">
          {sorted.length.toString()} today
        </span>
      </header>
      {sorted.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-tertiary)]">
          No alarms fired today. Quiet is good.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sorted.slice(0, 6).map((a) => {
            const Icon = SEVERITY_ICON[a.severity];
            const tint = SEVERITY_COLOR[a.severity];
            return (
              <li key={a.id}>
                <Link
                  href={
                    a.trackedKeywordId
                      ? `/t/${tenantSlug}/apps/${appId}/keywords/${a.trackedKeywordId}`
                      : `/t/${tenantSlug}/apps/${appId}/pulse`
                  }
                  className="group grid grid-cols-[24px_1fr_auto] items-start gap-2 rounded-[var(--radius)] px-2 py-2 transition-colors hover:bg-[var(--surface-tinted)]"
                >
                  <span
                    aria-hidden
                    className="grid h-5 w-5 place-items-center rounded-full"
                    style={{ background: `${tint}1a`, color: tint }}
                  >
                    <Icon size={11} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                      {a.title}
                    </p>
                    <p className="line-clamp-1 text-[12px] text-[var(--ink-secondary)]">
                      {a.message}
                    </p>
                  </div>
                  <ArrowRight
                    size={12}
                    className={cn(
                      "mt-1 text-[var(--ink-tertiary)]",
                      "transition-transform group-hover:translate-x-0.5",
                    )}
                  />
                </Link>
              </li>
            );
          })}
          {sorted.length > 6 && (
            <li className="border-t border-[var(--stroke-soft)] pt-2 text-[12px] text-[var(--ink-tertiary)]">
              + {(sorted.length - 6).toString()} more
              <Bell size={10} className="ml-1 inline" />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toLocaleString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
