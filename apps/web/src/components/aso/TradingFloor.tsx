"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { TrendingUp, TrendingDown, ArrowRight, RefreshCw, Clock } from "lucide-react";
import { Button, Card, Spinner, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

// ──────────────────────────────────────────────────────────────────────
// Types — mirrored from the server data shape
// ──────────────────────────────────────────────────────────────────────

export interface OverviewTotals {
  impressions: number;
  pageViews: number;
  downloads: number;
  firstTimeDownloads: number;
  pvcrPct: number;
}

export interface OverviewDelta {
  impressions: number | null;
  pageViews: number | null;
  downloads: number | null;
  pvcrPct: number | null;
}

export interface DailyPoint {
  date: string;
  downloads: number;
  pvcrPct: number;
}

export interface MoverItem {
  id: string;
  keyword: string;
  territory: string;
  bucket: string | null;
  latestScore: number;
  delta: number;
  deltaPct: number | null;
  latestRank: number | null;
  previousRank: number | null;
  latestVolume: number | null;
  latestDifficulty: number | null;
  spark: { date: string; score: number; rank: number | null }[];
}

export interface MetadataEventLite {
  id: string;
  pushedAt: string;
  locale: string;
  downloadDelta: number;
  downloadDeltaPct: number | null;
  diffSummary: { field: string; addedTokens: string[]; removedTokens: string[] }[];
}

export interface WatchlistItem {
  id: string;
  keyword: string;
  territory: string;
  bucket: string | null;
  score: number | null;
  rank: number | null;
  trends: number | null;
  spark: number[];
}

interface Props {
  tenantSlug: string;
  appId: string;
  appName: string;
  windowDays: number;
  totals: OverviewTotals;
  delta: OverviewDelta;
  sparkline: DailyPoint[];
  watchlist: WatchlistItem[];
  recentMoves: MetadataEventLite[];
  lastSyncAt: string | null;
  initialTicker: { gainers: MoverItem[]; losers: MoverItem[] };
}

// ──────────────────────────────────────────────────────────────────────
// Trading Floor
// ──────────────────────────────────────────────────────────────────────

export function TradingFloor({
  tenantSlug,
  appId,
  appName,
  windowDays,
  totals,
  delta,
  sparkline,
  watchlist,
  recentMoves,
  lastSyncAt,
  initialTicker,
}: Props): JSX.Element {
  const [ticker, setTicker] = useState(initialTicker);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function refreshTicker(): Promise<void> {
    setRefreshing(true);
    const res = await api<{ gainers: MoverItem[]; losers: MoverItem[] }>(
      `/api/v1/apps/${appId}/aso/movers?window=7`,
    );
    setRefreshing(false);
    if (!res.ok) {
      toast.error("Could not refresh movers", { description: res.message });
      return;
    }
    setTicker({ gainers: res.data.gainers, losers: res.data.losers });
  }

  async function triggerAnalyticsSync(): Promise<void> {
    setSyncing(true);
    const res = await api<{ jobId: string }>(`/api/v1/apps/${appId}/aso/sync`, {
      method: "POST",
      body: {},
    });
    setSyncing(false);
    if (!res.ok) {
      toast.error("Could not start analytics sync", { description: res.message });
      return;
    }
    toast.success("Analytics sync queued", { description: "Apple delivers data with ~36h latency." });
  }

  async function triggerBackfill(days: number): Promise<void> {
    setSyncing(true);
    const toDate = new Date();
    toDate.setUTCHours(0, 0, 0, 0);
    toDate.setUTCDate(toDate.getUTCDate() - 1);
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
    const body = {
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: toDate.toISOString().slice(0, 10),
    };
    const res = await api<{ jobId: string; days: number }>(`/api/v1/apps/${appId}/aso/sync`, {
      method: "POST",
      body,
    });
    setSyncing(false);
    if (!res.ok) {
      toast.error("Could not start backfill", { description: res.message });
      return;
    }
    toast.success(`Backfill queued (${res.data.days.toString()} days)`, {
      description: `${body.fromDate} → ${body.toDate}. Watch the worker log for progress.`,
    });
  }

  return (
    <div className="page-loaded space-y-8">
      {/* Header strip */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-[0.5px] border-[var(--stroke-default)] pb-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Trading floor · last {windowDays.toString()}d
          </p>
          <h2
            className="mt-1 font-display text-3xl leading-tight tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {appName}
          </h2>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] text-[var(--ink-tertiary)]">
          <Clock size={12} />
          {lastSyncAt ? (
            <span>Last sync {relativeTime(lastSyncAt)}</span>
          ) : (
            <span>No analytics data yet</span>
          )}
          <Button variant="ghost" size="sm" onClick={triggerAnalyticsSync} disabled={syncing}>
            {syncing ? <Spinner size={12} /> : "Sync yesterday"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void triggerBackfill(30)} disabled={syncing}>
            Backfill 30d
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void triggerBackfill(90)} disabled={syncing}>
            Backfill 90d
          </Button>
        </div>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile label="Impressions" value={formatCompact(totals.impressions)} delta={delta.impressions} subtitle={`Last ${windowDays.toString()}d`} />
        <KpiTile label="Page views" value={formatCompact(totals.pageViews)} delta={delta.pageViews} subtitle={`Last ${windowDays.toString()}d`} />
        <KpiTile label="Downloads" value={formatCompact(totals.downloads)} delta={delta.downloads} subtitle={`First-time ${formatCompact(totals.firstTimeDownloads)}`} />
        <KpiTile label="PVCR" value={`${totals.pvcrPct.toFixed(2)}%`} delta={delta.pvcrPct} subtitle="Page-view → install" suffix="pp" />
      </section>

      {/* Sparkline strip */}
      <Card className="space-y-2 overflow-hidden">
        <header className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Daily downloads
          </h3>
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/analytics`}
            className="font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
          >
            Open analytics →
          </Link>
        </header>
        {sparkline.length === 0 ? (
          <EmptyHint kind="data">
            No analytics data yet. Sync runs every morning ~10 UTC (Apple has ~36 h latency).
          </EmptyHint>
        ) : (
          <Sparkline points={sparkline.map((p) => p.downloads)} stroke="ink" height={64} />
        )}
      </Card>

      {/* Ticker tape */}
      <section>
        <header className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Ticker tape · 7-day movers
          </h3>
          <Button variant="ghost" size="sm" onClick={refreshTicker} disabled={refreshing}>
            <RefreshCw size={12} className={cn(refreshing && "animate-spin")} /> Refresh
          </Button>
        </header>
        <TickerTape gainers={ticker.gainers} losers={ticker.losers} tenantSlug={tenantSlug} appId={appId} />
      </section>

      {/* Watchlist */}
      <section>
        <header className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Watchlist · {watchlist.length.toString()} keyword{watchlist.length === 1 ? "" : "s"}
          </h3>
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/keywords`}
            className="font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
          >
            Manage keywords →
          </Link>
        </header>
        {watchlist.length === 0 ? (
          <EmptyHint kind="action">
            No keywords tracked yet.{" "}
            <Link
              href={`/t/${tenantSlug}/apps/${appId}/keywords`}
              className="underline hover:text-[var(--ink-primary)]"
            >
              Add some to start collecting signals.
            </Link>
          </EmptyHint>
        ) : (
          <Watchlist items={watchlist} tenantSlug={tenantSlug} appId={appId} />
        )}
      </section>

      {/* Recent moves */}
      <section>
        <header className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Recent moves · metadata pushes & their effect
          </h3>
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/keywords/history`}
            className="font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
          >
            Open history →
          </Link>
        </header>
        {recentMoves.length === 0 ? (
          <EmptyHint kind="data">
            No recent metadata pushes. Once you push from the Metadata tab, every change is
            snapshotted here with its 7-day download delta.
          </EmptyHint>
        ) : (
          <ul className="space-y-2">
            {recentMoves.map((m) => (
              <li key={m.id}>
                <RecentMoveCard event={m} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Pieces
// ──────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  subtitle,
  delta,
  suffix,
}: {
  label: string;
  value: string;
  subtitle: string;
  delta: number | null;
  suffix?: string;
}): JSX.Element {
  const tone = delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  return (
    <Card>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
        {label}
      </h3>
      <p
        className="mt-2 font-display text-[40px] leading-none tabular-nums"
        style={{ fontVariationSettings: "'wght' 450" }}
      >
        {value}
      </p>
      <div className="mt-2 flex items-baseline justify-between gap-2 font-mono text-[11px]">
        <span className="text-[var(--ink-secondary)]">{subtitle}</span>
        {delta !== null && (
          <span
            className={cn(
              "inline-flex items-center gap-1 tabular-nums",
              tone === "up" && "text-[var(--status-success)]",
              tone === "down" && "text-[var(--status-danger)]",
              tone === "flat" && "text-[var(--ink-tertiary)]",
            )}
          >
            {tone === "up" && <TrendingUp size={11} />}
            {tone === "down" && <TrendingDown size={11} />}
            {tone === "flat" && <ArrowRight size={11} />}
            {delta > 0 ? "+" : ""}
            {delta.toFixed(suffix ? 2 : 1)}
            {suffix ?? "%"}
          </span>
        )}
      </div>
    </Card>
  );
}

function TickerTape({
  gainers,
  losers,
  tenantSlug,
  appId,
}: {
  gainers: MoverItem[];
  losers: MoverItem[];
  tenantSlug: string;
  appId: string;
}): JSX.Element {
  const items = useMemo(() => {
    const merged: { item: MoverItem; tone: "up" | "down" }[] = [];
    for (const g of gainers) merged.push({ item: g, tone: "up" });
    for (const l of losers) merged.push({ item: l, tone: "down" });
    return merged;
  }, [gainers, losers]);

  if (items.length === 0) {
    return (
      <EmptyHint kind="data">
        Tracked keywords need at least 2 days of signals to compute movers. Refresh keyword
        signals to populate.
      </EmptyHint>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <ul className="flex min-w-max gap-6">
        {items.map(({ item, tone }) => (
          <li key={item.id}>
            <Link
              href={`/t/${tenantSlug}/apps/${appId}/keywords/${item.id}`}
              className={cn(
                "inline-flex items-baseline gap-2 font-mono text-[12px] tabular-nums",
                "hover:text-[var(--ink-primary)]",
              )}
            >
              <span
                className={cn(
                  "text-[14px]",
                  tone === "up" ? "text-[var(--status-success)]" : "text-[var(--status-danger)]",
                )}
              >
                {tone === "up" ? "▲" : "▼"}
              </span>
              <span className="font-body text-[13px] text-[var(--ink-primary)]">
                {item.keyword}
              </span>
              <span className="text-[var(--ink-tertiary)]">·</span>
              <span
                className={tone === "up" ? "text-[var(--status-success)]" : "text-[var(--status-danger)]"}
              >
                {item.delta > 0 ? "+" : ""}
                {item.delta.toFixed(2)}
              </span>
              {item.previousRank !== null && item.latestRank !== null && (
                <span className="text-[var(--ink-tertiary)]">
                  rank {item.previousRank.toString()}→{item.latestRank.toString()}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Watchlist({
  items,
  tenantSlug,
  appId,
}: {
  items: WatchlistItem[];
  tenantSlug: string;
  appId: string;
}): JSX.Element {
  return (
    <Card className="overflow-x-auto">
      <div className="min-w-[820px]">
        <div className="grid grid-cols-[1fr_70px_110px_80px_140px_60px_60px] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
          <span>Keyword</span>
          <span>CC</span>
          <span>Bucket</span>
          <span className="text-right">Score</span>
          <span>14d</span>
          <span className="text-right">Rank</span>
          <span className="text-right">Trends</span>
        </div>
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/t/${tenantSlug}/apps/${appId}/keywords/${item.id}`}
            className="grid grid-cols-[1fr_70px_110px_80px_140px_60px_60px] items-center gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2 font-mono text-[12px] tabular-nums hover:bg-[var(--surface-tinted)]"
          >
            <span className="truncate font-body text-[13px] text-[var(--ink-primary)]">{item.keyword}</span>
            <span className="uppercase text-[var(--ink-secondary)]">{item.territory}</span>
            <span>
              {item.bucket ? (
                <Stamp variant={bucketVariant(item.bucket)}>{item.bucket}</Stamp>
              ) : (
                <span className="text-[var(--ink-tertiary)]">—</span>
              )}
            </span>
            <span className="text-right">{item.score !== null ? item.score.toFixed(2) : "—"}</span>
            <span>
              <Sparkline points={item.spark.length > 0 ? item.spark : [0]} height={20} stroke="ink" />
            </span>
            <span className="text-right">{item.rank ?? "—"}</span>
            <span className="text-right">{item.trends ?? "—"}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function RecentMoveCard({ event }: { event: MetadataEventLite }): JSX.Element {
  const tone =
    event.downloadDelta > 0 ? "up" : event.downloadDelta < 0 ? "down" : "flat";
  const date = new Date(event.pushedAt);
  return (
    <Card className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span
            className="font-display text-[20px]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
          <Stamp>{event.locale}</Stamp>
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-2 font-mono text-[12px] tabular-nums",
            tone === "up" && "text-[var(--status-success)]",
            tone === "down" && "text-[var(--status-danger)]",
            tone === "flat" && "text-[var(--ink-tertiary)]",
          )}
        >
          {tone === "up" && <TrendingUp size={12} />}
          {tone === "down" && <TrendingDown size={12} />}
          downloads 7d{" "}
          {event.downloadDelta > 0 ? "+" : ""}
          {event.downloadDelta.toString()}
          {event.downloadDeltaPct !== null && (
            <span className="text-[var(--ink-tertiary)]">
              ({event.downloadDeltaPct > 0 ? "+" : ""}
              {event.downloadDeltaPct.toFixed(1)}%)
            </span>
          )}
        </div>
      </header>
      {event.diffSummary.length === 0 ? (
        <p className="font-body text-[12px] text-[var(--ink-tertiary)]">
          No tracked-field changes detected (only metadata that does not affect ASO surfaces moved).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {event.diffSummary.map((d, i) => (
            <li key={i} className="grid grid-cols-[140px_1fr] gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
                {d.field}
              </span>
              <span className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
                {d.addedTokens.slice(0, 8).map((t) => (
                  <Stamp key={`+${t}`} variant="success">
                    +{t}
                  </Stamp>
                ))}
                {d.removedTokens.slice(0, 8).map((t) => (
                  <Stamp key={`-${t}`} variant="danger">
                    −{t}
                  </Stamp>
                ))}
                {d.addedTokens.length === 0 && d.removedTokens.length === 0 && (
                  <span className="text-[var(--ink-tertiary)]">field text changed</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EmptyHint({
  kind,
  children,
}: {
  kind: "data" | "action";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card className={cn("border-dashed", kind === "action" && "border-[var(--ink-primary)]")}>
      <p className="font-body text-[13px] text-[var(--ink-secondary)]">{children}</p>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

export function Sparkline({
  points,
  height = 36,
  stroke = "ink",
}: {
  points: number[];
  height?: number;
  stroke?: "ink" | "success" | "danger";
}): JSX.Element {
  if (points.length === 0) {
    return <div className="h-full w-full rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />;
  }
  const w = 120;
  const h = height;
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((p, i) => `${(i * step).toFixed(2)},${(h - ((p - min) / range) * h).toFixed(2)}`)
    .join(" ");
  const strokeVar = stroke === "success" ? "var(--status-success)" : stroke === "danger" ? "var(--status-danger)" : "var(--ink-primary)";
  return (
    <svg viewBox={`0 0 ${w.toString()} ${h.toString()}`} className="h-full w-full" preserveAspectRatio="none" style={{ height: `${h.toString()}px` }}>
      <polyline points={path} fill="none" stroke={strokeVar} strokeWidth="1" />
    </svg>
  );
}

function bucketVariant(bucket: string): "default" | "success" | "warning" | "danger" {
  switch (bucket) {
    case "CHAMPION":
      return "success";
    case "OPPORTUNITY":
    case "RISING":
      return "warning";
    case "DECAY":
      return "danger";
    default:
      return "default";
  }
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toLocaleString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m.toString()}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h.toString()}h ago`;
  const d = Math.floor(h / 24);
  return `${d.toString()}d ago`;
}

