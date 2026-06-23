"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Clock,
  Pin,
  ChevronRight,
  History,
  Sparkles,
} from "lucide-react";
import { Button, Card, Spinner, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { KeywordDetailPopover } from "@/components/metadata/KeywordDetailPopover";

// ──────────────────────────────────────────────────────────────────────
// Data shape (mirrors /api/v1/apps/[id]/aso/dashboard)
// ──────────────────────────────────────────────────────────────────────

export interface DashboardData {
  range: string;
  windowDays: number;
  app: {
    id: string;
    appName: string;
    platform: "IOS" | "ANDROID";
    primaryLocale: string;
    bundleId: string;
    activeLocales: number;
    lastFetchedAt: string | null;
    lastPushedAt: string | null;
  };
  totals: {
    impressions: number;
    pageViews: number;
    downloads: number;
    firstTimeDownloads: number;
    pvcrPct: number;
  };
  delta: {
    impressions: number | null;
    pageViews: number | null;
    downloads: number | null;
    pvcrPctPoints: number | null;
  };
  downloadsDaily: {
    date: string;
    downloads: number;
    pageViews: number;
    impressions: number;
    pvcrPct: number;
  }[];
  territories: { territory: string; units: number; pageViews: number }[];
  devices: { device: string; share: number }[];
  keywords: {
    items: {
      id: string;
      keyword: string;
      territory: string;
      source: string;
      bucket: string | null;
      score: number | null;
      rank: number | null;
      /** Astro difficulty 0–100. */
      difficulty: number | null;
      /** Astro max reach chance. */
      maxReachChance: number | null;
      liveLocales: string[];
    }[];
    totalTracked: number;
    liveInPrimary: number;
    primaryLocale: string;
  };
  currentMetadata: {
    locale: string;
    name: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    description: string | null;
    lastPushedAt: string | null;
    dirty: boolean;
    keywordsFieldChars: number;
    keywordsFieldTokens: number;
  } | null;
  recentMoves: {
    id: string;
    locale: string;
    pushedAt: string;
    downloadsBefore: number;
    downloadsAfter: number;
    downloadDelta: number;
    downloadDeltaPct: number | null;
    addedTokens: string[];
    removedTokens: string[];
    changedFields: string[];
  }[];
}

const RANGES = ["7d", "30d", "90d", "1y"] as const;

interface Props {
  tenantSlug: string;
  initialData: DashboardData;
}

// ──────────────────────────────────────────────────────────────────────

interface SmartSyncResponse {
  analytics: {
    queued: boolean;
    mode: "first-backfill" | "catch-up" | "refresh-yesterday" | "skipped-not-ios";
    days: number;
    fromDate: string | null;
    toDate: string | null;
  };
  keywords: {
    queued: boolean;
    activeCount: number;
    reason?: string;
  };
  metadataImport: {
    importedCount: number;
    skippedExisting: number;
    perLocale: { locale: string }[];
  };
}

export function Overview({ tenantSlug, initialData }: Props): JSX.Element {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [range, setRange] = useState<(typeof RANGES)[number]>(
    (initialData.range as (typeof RANGES)[number]) ?? "30d",
  );
  const [syncing, setSyncing] = useState(false);
  const [, startTransition] = useTransition();

  async function setRangeAndRefetch(next: (typeof RANGES)[number]): Promise<void> {
    setRange(next);
    const res = await api<DashboardData>(`/api/v1/apps/${data.app.id}/aso/dashboard?range=${next}`);
    if (!res.ok) {
      toast.error("Could not load range", { description: res.message });
      return;
    }
    setData(res.data);
  }

  async function handleSync(): Promise<void> {
    setSyncing(true);
    const res = await api<SmartSyncResponse>(`/api/v1/apps/${data.app.id}/aso/sync`, {
      method: "POST",
      body: {},
    });
    setSyncing(false);
    if (!res.ok) {
      toast.error("Sync failed", { description: res.message });
      return;
    }
    toast.success("Smart sync started", { description: describeSync(res.data) });
    startTransition(() => router.refresh());
  }

  return (
    <div className="page-loaded space-y-8">
      {/* ────────── Header strip ────────── */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-[0.5px] border-[var(--stroke-default)] pb-5">
        <div>
          <p className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            ASO · {data.app.platform === "IOS" ? "App Store" : "Google Play"} ·{" "}
            {data.app.activeLocales.toString()} locale{data.app.activeLocales === 1 ? "" : "s"} ·{" "}
            {data.keywords.totalTracked.toString()} tracked keyword
            {data.keywords.totalTracked === 1 ? "" : "s"}
          </p>
          <h1
            className="font-display mt-1 text-3xl leading-tight tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {data.app.appName}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {data.app.lastFetchedAt && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--ink-tertiary)]">
              <Clock size={12} />
              Synced <RelativeTime iso={data.app.lastFetchedAt} />
            </span>
          )}
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => void setRangeAndRefetch(r)}
                className={cn(
                  "rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] uppercase transition-colors",
                  r === range
                    ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                    : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={handleSync} disabled={syncing}>
            {syncing ? <Spinner size={12} /> : <Sparkles size={12} />}
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        </div>
      </header>

      {/* ────────── KPI strip ────────── */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          label="App Units"
          value={formatCompact(data.totals.downloads)}
          sub={`${formatCompact(data.totals.firstTimeDownloads)} first-time`}
          delta={data.delta.downloads}
        />
        <Kpi
          label="Page Views"
          value={formatCompact(data.totals.pageViews)}
          sub="Product page views"
          delta={data.delta.pageViews}
        />
        <Kpi
          label="Impressions"
          value={formatCompact(data.totals.impressions)}
          sub="Search + browse"
          delta={data.delta.impressions}
        />
        <Kpi
          label="Conversion"
          value={`${data.totals.pvcrPct.toFixed(2)}%`}
          sub="Page view → install"
          delta={data.delta.pvcrPctPoints}
          suffix="pp"
          precision={2}
        />
      </section>

      {/* ────────── Downloads chart ────────── */}
      <Card className="space-y-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            App Units · daily{" "}
            {data.recentMoves.length > 0 ? " · push events overlaid in signal" : ""}
          </h2>
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {data.windowDays.toString()}d · {data.downloadsDaily.length.toString()} day
            {data.downloadsDaily.length === 1 ? "" : "s"}
          </span>
        </header>
        {data.downloadsDaily.length === 0 ? (
          <Empty>
            No analytics data yet for this window. Hit{" "}
            <strong className="font-mono text-[var(--ink-primary)]">Backfill 90d</strong> above to
            populate history — Apple typically delivers 12 months of past data on the first
            connection.
          </Empty>
        ) : (
          <DownloadsChart
            series={data.downloadsDaily}
            markers={data.recentMoves.map((m) => ({
              date: m.pushedAt.slice(0, 10),
              locale: m.locale,
            }))}
          />
        )}
      </Card>

      {/* ────────── Territory + Devices ────────── */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="space-y-3">
          <header className="flex items-center justify-between gap-3">
            <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
              Territories · top {data.territories.length.toString() || "—"}
            </h2>
            <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">by App Units</span>
          </header>
          {data.territories.length === 0 ? (
            <Empty>
              Per-territory breakdown shows once Apple's "Discovery and Engagement" report
              populates. Try syncing analytics from the header.
            </Empty>
          ) : (
            <TerritoryList rows={data.territories} />
          )}
        </Card>
        <Card className="space-y-3">
          <header className="flex items-center justify-between gap-3">
            <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
              Devices
            </h2>
            <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
              iPhone / iPad / Desktop
            </span>
          </header>
          {data.devices.length === 0 ? (
            <Empty>
              Device breakdown requires Apple's <em>Detailed</em> Engagement report tier — Apple
              unlocks it once your app crosses their privacy thresholds (~1,000 downloads).
            </Empty>
          ) : (
            <DeviceDonut rows={data.devices} />
          )}
        </Card>
      </section>

      {/* ────────── Keywords ────────── */}
      <section>
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
              Your keywords · {data.keywords.totalTracked.toString()} tracked ·{" "}
              <span className="text-[var(--ink-primary)]">
                {data.keywords.liveInPrimary.toString()} live in {data.keywords.primaryLocale}
              </span>
            </h2>
          </div>
          <Link
            href={`/t/${tenantSlug}/apps/${data.app.id}/keywords`}
            className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
          >
            Manage keywords <ChevronRight size={11} />
          </Link>
        </header>
        {data.keywords.items.length === 0 ? (
          <Empty>
            No active keywords tracked yet. Head to{" "}
            <Link
              href={`/t/${tenantSlug}/apps/${data.app.id}/keywords`}
              className="text-[var(--ink-primary)] underline"
            >
              Keywords
            </Link>{" "}
            and click <strong>Import from metadata</strong> to seed from each locale's keywords
            field.
          </Empty>
        ) : (
          <KeywordsTable
            items={data.keywords.items}
            primaryLocale={data.keywords.primaryLocale}
            tenantSlug={tenantSlug}
            appId={data.app.id}
          />
        )}
      </section>

      {/* ────────── Live metadata + recent moves ────────── */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr]">
        <MetadataNow tenantSlug={tenantSlug} appId={data.app.id} metadata={data.currentMetadata} />
        <RecentMoves tenantSlug={tenantSlug} appId={data.app.id} moves={data.recentMoves} />
      </section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Pieces
// ──────────────────────────────────────────────────────────────────────

function describeSync(r: SmartSyncResponse): string {
  const parts: string[] = [];
  if (r.analytics.queued) {
    if (r.analytics.mode === "first-backfill") {
      parts.push(`Analytics ${r.analytics.days.toString()} day backfill`);
    } else if (r.analytics.mode === "catch-up") {
      parts.push(
        `Analytics catch-up ${r.analytics.days.toString()} day${r.analytics.days === 1 ? "" : "s"}`,
      );
    } else if (r.analytics.mode === "refresh-yesterday") {
      parts.push("Analytics refresh");
    }
  } else if (r.analytics.mode === "skipped-not-ios") {
    parts.push("Analytics skipped (Android)");
  }
  if (r.keywords.queued) {
    parts.push(
      `${r.keywords.activeCount.toString()} keyword${r.keywords.activeCount === 1 ? "" : "s"}`,
    );
  }
  if (r.metadataImport.importedCount > 0) {
    parts.push(`${r.metadataImport.importedCount.toString()} new from metadata`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing to sync — everything is up to date.";
}

function Kpi({
  label,
  value,
  sub,
  delta,
  suffix,
  precision,
}: {
  label: string;
  value: string;
  sub: string;
  delta: number | null;
  suffix?: string;
  precision?: number;
}): JSX.Element {
  const tone = delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const p = precision ?? 1;
  return (
    <Card>
      <h3 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
        {label}
      </h3>
      <p
        className="font-display mt-2 text-[40px] leading-none tabular-nums"
        style={{ fontVariationSettings: "'wght' 450" }}
      >
        {value}
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-2 font-mono text-[11px]">
        <span className="text-[var(--ink-secondary)]">{sub}</span>
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
            {delta.toFixed(p)}
            {suffix ?? "%"}
          </span>
        )}
      </div>
    </Card>
  );
}

function DownloadsChart({
  series,
  markers,
}: {
  series: DashboardData["downloadsDaily"];
  markers: { date: string; locale: string }[];
}): JSX.Element {
  // ASC Trends-style daily BAR chart. Each day's App Units is one bar;
  // metadata push events are vertical signal lines that cut through.
  const w = 960;
  const h = 240;
  const pad = { l: 40, r: 12, t: 16, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const max = Math.max(...series.map((d) => d.downloads), 1);
  const slotW = series.length > 0 ? innerW / series.length : 0;
  const barW = Math.max(2, slotW * 0.78);
  const gap = (slotW - barW) / 2;

  const dateToIndex = new Map<string, number>();
  series.forEach((d, i) => dateToIndex.set(d.date, i));
  const markerLines = markers
    .map((m) => {
      const idx = dateToIndex.get(m.date) ?? nearestIndex(series, m.date);
      if (idx < 0) return null;
      return { x: pad.l + idx * slotW + slotW / 2, locale: m.locale };
    })
    .filter((x): x is { x: number; locale: string } => x !== null);

  return (
    <svg
      viewBox={`0 0 ${w.toString()} ${h.toString()}`}
      className="w-full"
      style={{ height: `${h.toString()}px` }}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = pad.t + innerH - t * innerH;
        const value = Math.round(t * max);
        return (
          <g key={t}>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={y}
              y2={y}
              stroke="var(--stroke-default)"
              strokeWidth="0.5"
            />
            <text
              x={pad.l - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-[var(--ink-tertiary)] font-mono"
              fontSize="9"
            >
              {value.toLocaleString()}
            </text>
          </g>
        );
      })}

      {/* push markers behind bars */}
      {markerLines.map((m, i) => (
        <line
          key={i}
          x1={m.x}
          x2={m.x}
          y1={pad.t}
          y2={h - pad.b}
          stroke="var(--signal)"
          strokeWidth="0.8"
          strokeDasharray="2 3"
        />
      ))}

      {/* daily bars */}
      {series.map((d, i) => {
        const barH = (d.downloads / max) * innerH;
        const x = pad.l + i * slotW + gap;
        const y = pad.t + innerH - barH;
        return (
          <rect
            key={d.date}
            x={x}
            y={y}
            width={barW}
            height={Math.max(barH, d.downloads > 0 ? 1 : 0)}
            rx={1}
            fill="var(--ink-primary)"
            fillOpacity={d.downloads === 0 ? 0.15 : 0.95}
          />
        );
      })}

      {series.length > 0 && (
        <>
          <text x={pad.l} y={h - 6} className="fill-[var(--ink-tertiary)] font-mono" fontSize="9">
            {series[0]!.date}
          </text>
          <text
            x={w - pad.r}
            y={h - 6}
            textAnchor="end"
            className="fill-[var(--ink-tertiary)] font-mono"
            fontSize="9"
          >
            {series[series.length - 1]!.date}
          </text>
        </>
      )}
    </svg>
  );
}

function TerritoryList({ rows }: { rows: DashboardData["territories"] }): JSX.Element {
  // ASC-Trends-style vertical bars with the country code beneath and
  // the count floating above each bar. Palette cycles through three
  // tones to give the chart the same playful feel as ASC.
  const max = Math.max(...rows.map((r) => r.units), 1);
  const palette = ["var(--ink-primary)", "var(--signal)", "#7BCDB6", "#A8DC92", "#D4E480"];
  return (
    <div className="flex h-[180px] items-end justify-around gap-2 px-2 pt-7">
      {rows.map((r, i) => {
        const h = (r.units / max) * 140;
        return (
          <div key={r.territory} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--ink-primary)] tabular-nums">
              {r.units.toLocaleString()}
            </span>
            <div
              className="w-full max-w-[42px] rounded-t-[var(--radius-xs)]"
              style={{
                height: `${Math.max(h, 2).toFixed(1)}px`,
                background: palette[i % palette.length]!,
              }}
            />
            <span className="max-w-full truncate font-mono text-[10px] tracking-[0.06em] text-[var(--ink-secondary)] uppercase">
              {r.territory}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DeviceDonut({ rows }: { rows: DashboardData["devices"] }): JSX.Element {
  const total = rows.reduce((s, r) => s + r.share, 0) || 1;
  const radius = 48;
  const cx = 60;
  const cy = 60;
  const stroke = 14;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const palette = [
    "var(--ink-primary)",
    "var(--signal)",
    "var(--ink-tertiary)",
    "var(--status-warning)",
  ];
  return (
    <div className="flex items-center gap-6">
      <svg width="120" height="120" viewBox="0 0 120 120" className="shrink-0">
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="var(--surface-tinted)"
          strokeWidth={stroke}
        />
        {rows.map((r, i) => {
          const share = (r.share / total) * circumference;
          const dasharray = `${share.toFixed(2)} ${(circumference - share).toFixed(2)}`;
          const dashoffset = -offset;
          offset += share;
          return (
            <circle
              key={r.device}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={palette[i % palette.length]}
              strokeWidth={stroke}
              strokeDasharray={dasharray}
              strokeDashoffset={dashoffset}
              transform={`rotate(-90 ${cx.toString()} ${cy.toString()})`}
            />
          );
        })}
      </svg>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.device} className="flex items-center gap-3 font-mono text-[12px]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: palette[i % palette.length]! }}
            />
            <span className="text-[var(--ink-primary)] tabular-nums">{r.share.toFixed(0)}%</span>
            <span className="text-[var(--ink-secondary)]">{r.device}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeywordsTable({
  items,
  primaryLocale,
  tenantSlug,
  appId,
}: {
  items: DashboardData["keywords"]["items"];
  primaryLocale: string;
  tenantSlug: string;
  appId: string;
}): JSX.Element {
  void tenantSlug;
  // Click any row → open the same research-dossier popover the metadata
  // workbench uses, so the user can drill into score components, raw
  // signals and recommended action without navigating away from
  // Overview.
  const [openKw, setOpenKw] = useState<{ id: string; keyword: string; territory: string } | null>(
    null,
  );
  return (
    <Card className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[1fr_70px_120px_70px_70px_70px_160px] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
          <span>Keyword</span>
          <span>CC</span>
          <span>Bucket</span>
          <span className="text-right">Score</span>
          <span className="text-right">Rank</span>
          <span className="text-right">Trends</span>
          <span>Live in metadata</span>
        </div>
        {items.map((k) => {
          const livePrimary = k.liveLocales.includes(primaryLocale);
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => setOpenKw({ id: k.id, keyword: k.keyword, territory: k.territory })}
              className="grid w-full grid-cols-[1fr_70px_120px_70px_70px_70px_160px] items-center gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2.5 text-left font-mono text-[12px] tabular-nums hover:bg-[var(--surface-tinted)] focus:bg-[var(--surface-tinted)] focus:outline-none"
              title="Click to open research dossier"
            >
              <span className="font-body truncate text-[13px] text-[var(--ink-primary)]">
                {k.keyword}
              </span>
              <span className="text-[var(--ink-secondary)] uppercase">{k.territory}</span>
              <span>
                {k.bucket ? (
                  <Stamp variant={bucketVariant(k.bucket)}>{k.bucket}</Stamp>
                ) : (
                  <span className="text-[var(--ink-tertiary)]">—</span>
                )}
              </span>
              <span className="text-right">{k.score !== null ? k.score.toFixed(2) : "—"}</span>
              <span className="text-right">{k.rank ?? "—"}</span>
              <span className="text-right">{k.difficulty ?? "—"}</span>
              <span className="flex flex-wrap items-center gap-1">
                {k.liveLocales.length === 0 ? (
                  <span className="text-[var(--ink-tertiary)]">not in field</span>
                ) : (
                  <>
                    <Pin
                      size={10}
                      className={
                        livePrimary ? "text-[var(--status-success)]" : "text-[var(--ink-tertiary)]"
                      }
                    />
                    {k.liveLocales.slice(0, 3).map((loc) => (
                      <Stamp key={loc} variant={loc === primaryLocale ? "success" : "default"}>
                        {loc}
                      </Stamp>
                    ))}
                    {k.liveLocales.length > 3 && (
                      <span className="text-[var(--ink-tertiary)]">
                        +{(k.liveLocales.length - 3).toString()}
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {openKw && (
        <KeywordDetailPopover
          appId={appId}
          keywordId={openKw.id}
          keywordText={openKw.keyword}
          territory={openKw.territory}
          onClose={() => setOpenKw(null)}
        />
      )}
    </Card>
  );
}

function MetadataNow({
  tenantSlug,
  appId,
  metadata,
}: {
  tenantSlug: string;
  appId: string;
  metadata: DashboardData["currentMetadata"];
}): JSX.Element {
  if (!metadata) {
    return (
      <Card className="border-dashed">
        <p className="font-body text-[13px] text-[var(--ink-secondary)]">
          No metadata fetched yet — go to the{" "}
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/metadata`}
            className="text-[var(--ink-primary)] underline"
          >
            Metadata tab
          </Link>{" "}
          and click <strong>Fetch</strong>.
        </p>
      </Card>
    );
  }
  const tokens = parseTokens(metadata.keywordsField);
  const charBudget = 100;
  const charPct = Math.min(100, (metadata.keywordsFieldChars / charBudget) * 100);
  return (
    <Card className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            Live metadata
          </h2>
          <p
            className="font-display mt-1 text-[20px]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {metadata.locale}
          </p>
        </div>
        <Link
          href={`/t/${tenantSlug}/apps/${appId}/metadata`}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
        >
          Edit metadata <ChevronRight size={11} />
        </Link>
      </header>
      <dl className="space-y-3">
        <Row label="Title" value={metadata.name} maxLen={30} />
        {metadata.subtitle !== null && (
          <Row label="Subtitle" value={metadata.subtitle} maxLen={30} />
        )}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <dt className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              Keywords field
            </dt>
            <dd className="font-mono text-[11px] text-[var(--ink-tertiary)] tabular-nums">
              {metadata.keywordsFieldChars.toString()}/{charBudget.toString()} chars ·{" "}
              <span className="text-[var(--ink-primary)]">{tokens.length.toString()}</span> token
              {tokens.length === 1 ? "" : "s"}
            </dd>
          </div>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-[var(--surface-tinted)]">
            <div
              className={cn(
                "h-full",
                metadata.keywordsFieldChars > charBudget
                  ? "bg-[var(--status-danger)]"
                  : "bg-[var(--ink-primary)]",
              )}
              style={{ width: `${charPct.toFixed(1)}%` }}
            />
          </div>
          {tokens.length === 0 ? (
            <p className="font-mono text-[12px] text-[var(--ink-tertiary)]">
              Empty — add comma-separated terms in the Metadata tab.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tokens.map((t) => (
                <Stamp key={t}>{t}</Stamp>
              ))}
            </div>
          )}
        </div>
        {metadata.promotionalText !== null && metadata.promotionalText.length > 0 && (
          <Row label="Promo text" value={metadata.promotionalText} maxLen={170} />
        )}
      </dl>
      <footer className="flex items-baseline justify-between gap-3 border-t-[0.5px] border-[var(--stroke-default)] pt-3 font-mono text-[11px] text-[var(--ink-tertiary)]">
        <span>
          {metadata.lastPushedAt ? (
            <>
              Last pushed <RelativeTime iso={metadata.lastPushedAt} />
            </>
          ) : (
            "Never pushed"
          )}
        </span>
        {metadata.dirty && <Stamp variant="warning">Pending Push</Stamp>}
      </footer>
    </Card>
  );
}

function RecentMoves({
  tenantSlug,
  appId,
  moves,
}: {
  tenantSlug: string;
  appId: string;
  moves: DashboardData["recentMoves"];
}): JSX.Element {
  return (
    <Card className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Recent metadata changes
        </h2>
        <Link
          href={`/t/${tenantSlug}/apps/${appId}/keywords/history`}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
        >
          <History size={11} /> History
        </Link>
      </header>
      {moves.length === 0 ? (
        <Empty>
          No recent pushes in this window. Push from the Metadata tab and the effect on downloads
          shows up here.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {moves.slice(0, 5).map((m) => {
            const tone = m.downloadDelta > 0 ? "up" : m.downloadDelta < 0 ? "down" : "flat";
            const date = new Date(m.pushedAt);
            return (
              <li
                key={m.id}
                className="flex items-baseline gap-3 border-t-[0.5px] border-[var(--stroke-default)] pt-2 font-mono text-[12px]"
              >
                <span className="w-[58px] text-[var(--ink-secondary)]">
                  {date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <Stamp>{m.locale}</Stamp>
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
                  {m.downloadDelta > 0 ? "+" : ""}
                  {m.downloadDelta.toLocaleString()}
                  {m.downloadDeltaPct !== null && (
                    <span className="text-[var(--ink-tertiary)]">
                      ({m.downloadDeltaPct > 0 ? "+" : ""}
                      {m.downloadDeltaPct.toFixed(1)}%)
                    </span>
                  )}
                </span>
                <span className="flex-1 truncate text-right text-[var(--ink-tertiary)]">
                  {m.addedTokens.length > 0 && (
                    <span className="text-[var(--status-success)]">
                      +{m.addedTokens.slice(0, 3).join(", ")}
                    </span>
                  )}
                  {m.addedTokens.length > 0 && m.removedTokens.length > 0 && " · "}
                  {m.removedTokens.length > 0 && (
                    <span className="text-[var(--status-danger)]">
                      −{m.removedTokens.slice(0, 3).join(", ")}
                    </span>
                  )}
                  {m.addedTokens.length === 0 &&
                    m.removedTokens.length === 0 &&
                    m.changedFields.length > 0 && (
                      <span>changed: {m.changedFields.join(", ")}</span>
                    )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Row({
  label,
  value,
  maxLen,
}: {
  label: string;
  value: string | null;
  maxLen: number;
}): JSX.Element {
  const len = (value ?? "").length;
  const tone = len > maxLen ? "over" : "ok";
  return (
    <div className="grid grid-cols-[120px_1fr_80px] items-baseline gap-3 border-t-[0.5px] border-[var(--stroke-default)] pt-2">
      <dt className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        {label}
      </dt>
      <dd className="font-body text-[14px] text-[var(--ink-primary)]">
        {value === null || value === "" ? (
          <span className="font-mono text-[12px] text-[var(--ink-tertiary)]">empty</span>
        ) : (
          value
        )}
      </dd>
      <span
        className={cn(
          "text-right font-mono text-[11px] tabular-nums",
          tone === "over" ? "text-[var(--status-danger)]" : "text-[var(--ink-tertiary)]",
        )}
      >
        {len.toString()}/{maxLen.toString()}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="font-body rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-5 text-[12px] text-[var(--ink-secondary)]">
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

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

function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toLocaleString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

export function formatRelativeTime(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m.toString()}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h.toString()}h ago`;
  const d = Math.floor(h / 24);
  return `${d.toString()}d ago`;
}

/**
 * Renders a "5m ago"-style relative timestamp.
 *
 * Hydration safety: we render NOTHING on SSR + first client render
 * (returning null when `now` hasn't been set yet), then upgrade to the
 * relative form once `useEffect` fires post-hydration. This guarantees
 * the server output and the first client render are byte-identical —
 * `suppressHydrationWarning` alone wasn't enough because React 19
 * still surfaces a hydration ERROR when child text content disagrees
 * (it only suppresses the WARNING, not the structural diff).
 */
function RelativeTime({ iso }: { iso: string }): JSX.Element | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  if (now == null) return null;
  return <span>{formatRelativeTime(iso, now)}</span>;
}

function nearestIndex(series: { date: string }[], date: string): number {
  const target = new Date(date).getTime();
  let best = -1;
  let bestDiff = Infinity;
  series.forEach((s, i) => {
    const d = Math.abs(new Date(s.date).getTime() - target);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  });
  return best;
}

function parseTokens(raw: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((t) => t.trim().replace(/\s+/g, " "))
        .filter((t) => t.length >= 1),
    ),
  );
}
