"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, TrendingUp, TrendingDown } from "lucide-react";
import { Card, Stamp, cn } from "@marquee/ui";
import { Sparkline } from "./TradingFloor";

export interface KeywordDetailSignal {
  date: string;
  appStoreRank: number | null;
  /** Astro popularity (0–100, Apple's real search index). */
  volume: number | null;
  /** Scale cap, typically 100. */
  maxVolume: number | null;
  /** Astro 0–100 keyword difficulty. */
  difficulty: number | null;
  /** Astro max reach chance. */
  maxReachChance: number | null;
  score: number | null;
  bucket: string | null;
}

export interface KeywordDetailDownload {
  date: string;
  downloads: number;
  pageViews: number;
  pvcrPct: number;
}

export interface KeywordDetailPushAnnotation {
  id: string;
  locale: string;
  pushedAt: string;
  keywordsField: string | null;
  name: string | null;
  subtitle: string | null;
}

export interface KeywordDetailAlternative {
  id: string;
  keyword: string;
  territory: string;
  score: number | null;
  bucket: string | null;
  rank: number | null;
  overlap: number;
}

export interface KeywordDetailData {
  keyword: {
    id: string;
    keyword: string;
    territory: string;
    source: string;
    status: string;
    notes: string | null;
    createdAt: string;
  };
  range: string;
  windowDays: number;
  signals: KeywordDetailSignal[];
  downloads: KeywordDetailDownload[];
  pushAnnotations: KeywordDetailPushAnnotation[];
  alternatives: KeywordDetailAlternative[];
}

interface Props {
  tenantSlug: string;
  appId: string;
  data: KeywordDetailData;
}

const RANGES = ["14d", "30d", "90d", "180d"] as const;

export function KeywordDetail({ tenantSlug, appId, data }: Props): JSX.Element {
  const [range, setRange] = useState<(typeof RANGES)[number]>(
    (data.range as (typeof RANGES)[number]) ?? "30d",
  );
  const signals = data.signals;
  const latest = signals[signals.length - 1] ?? null;
  const first = signals[0] ?? null;
  const scoreDelta =
    latest?.score !== null && latest?.score !== undefined && first?.score !== null && first?.score !== undefined
      ? latest.score - first.score
      : null;
  const rankDelta =
    latest?.appStoreRank !== null && latest?.appStoreRank !== undefined && first?.appStoreRank !== null && first?.appStoreRank !== undefined
      ? first.appStoreRank - latest.appStoreRank // positive = improved (smaller rank number)
      : null;

  return (
    <div className="page-loaded space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-[0.5px] border-[var(--stroke-default)] pb-5">
        <div>
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/pulse`}
            className="mb-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
          >
            <ArrowLeft size={11} /> Back to ASO overview
          </Link>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Astro keyword detail
          </p>
          <div className="flex items-center gap-3">
            <h1
              className="font-display text-4xl leading-tight tracking-[-0.02em]"
              style={{ fontVariationSettings: "'wght' 550" }}
            >
              {data.keyword.keyword}
            </h1>
            <Stamp>{data.keyword.territory}</Stamp>
            {latest?.bucket && (
              <Stamp variant={bucketVariant(latest.bucket)}>{latest.bucket}</Stamp>
            )}
            <Stamp variant={data.keyword.status === "ACTIVE" ? "success" : "default"}>
              {data.keyword.status}
            </Stamp>
            {data.keyword.source !== "MANUAL" && (
              <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                from {data.keyword.source.toLowerCase().replace("_", " ")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`?range=${r}`}
              onClick={() => setRange(r)}
              className={cn(
                "rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors",
                range === r
                  ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                  : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {r}
            </Link>
          ))}
        </div>
      </header>

      {/* Stat strip */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Score"
          value={latest?.score !== null && latest?.score !== undefined ? latest.score.toFixed(2) : "—"}
          delta={scoreDelta}
          suffix=""
          fractionDigits={2}
        />
        <StatTile
          label="Rank"
          value={latest?.appStoreRank !== null && latest?.appStoreRank !== undefined ? latest.appStoreRank.toString() : "off-list"}
          delta={rankDelta}
          suffix=" pos"
          fractionDigits={0}
        />
        <StatTile
          label="Astro popularity"
          value={latest?.volume !== null && latest?.volume !== undefined ? latest.volume.toString() : "—"}
          delta={null}
          suffix="/100"
          fractionDigits={0}
        />
        <StatTile
          label="Astro difficulty"
          value={latest?.difficulty !== null && latest?.difficulty !== undefined ? latest.difficulty.toString() : "—"}
          delta={null}
          suffix="/100"
          fractionDigits={0}
        />
      </section>

      {/* Main chart */}
      <Card className="space-y-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Astro composite score over time · push annotations mark metadata changes
          </h2>
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {data.windowDays.toString()}d · {signals.length.toString()} sample{signals.length === 1 ? "" : "s"}
          </span>
        </header>
        {signals.length === 0 ? (
          <p className="rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-6 text-center font-body text-[12px] text-[var(--ink-tertiary)]">
            No Astro signals collected yet. Run <strong>Astro Autopilot</strong> on the
            metadata workbench to populate rank, popularity, difficulty + max reach
            chance for this keyword.
          </p>
        ) : (
          <ScoreChart signals={signals} annotations={data.pushAnnotations} />
        )}
      </Card>

      {/* Astro signal mini-charts side-by-side */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MiniChart
          label="Astro · App Store rank"
          help="Lower is better (1 = top of search results). Off-list (>50) renders as 0 on the chart."
          points={signals.map((s) => (s.appStoreRank !== null ? 51 - s.appStoreRank : 0))}
          tone="up"
        />
        <MiniChart
          label="Astro · popularity"
          help="0–100. Apple's real search index — how often this term is being searched for. Pulled from Astro's add_keywords response."
          points={signals.map((s) => s.volume ?? 0)}
        />
        <MiniChart
          label="App downloads (same window)"
          help={`Daily install volume — useful for correlating "did this keyword move our downloads?" with the rank/popularity series.`}
          points={data.downloads.map((d) => d.downloads)}
        />
      </section>

      {/* Push annotations */}
      {data.pushAnnotations.length > 0 && (
        <section>
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Pushes that shipped this keyword in metadata
          </h2>
          <ul className="space-y-2">
            {data.pushAnnotations.map((a) => (
              <li key={a.id}>
                <Card className="space-y-1">
                  <header className="flex items-baseline justify-between gap-3">
                    <span
                      className="font-display text-[18px]"
                      style={{ fontVariationSettings: "'wght' 500" }}
                    >
                      {new Date(a.pushedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    <Stamp>{a.locale}</Stamp>
                  </header>
                  {a.keywordsField && (
                    <p className="font-mono text-[11px] text-[var(--ink-secondary)]">
                      keywords field:{" "}
                      <span className="text-[var(--ink-primary)]">{a.keywordsField}</span>
                    </p>
                  )}
                  {a.subtitle && (
                    <p className="font-mono text-[11px] text-[var(--ink-secondary)]">
                      subtitle:{" "}
                      <span className="text-[var(--ink-primary)]">{a.subtitle}</span>
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Alternatives */}
      {data.alternatives.length > 0 && (
        <section>
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Token-overlap alternatives — keywords on your watchlist sharing words
          </h2>
          <Card className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[1fr_70px_110px_80px_80px] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                <span>Keyword</span>
                <span>Shared</span>
                <span>Bucket</span>
                <span className="text-right">Score</span>
                <span className="text-right">Rank</span>
              </div>
              {data.alternatives.map((alt) => (
                <Link
                  key={alt.id}
                  href={`/t/${tenantSlug}/apps/${appId}/keywords/${alt.id}`}
                  className="grid grid-cols-[1fr_70px_110px_80px_80px] items-center gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2 font-mono text-[12px] tabular-nums hover:bg-[var(--surface-tinted)]"
                >
                  <span className="font-body text-[13px] text-[var(--ink-primary)]">{alt.keyword}</span>
                  <span className="text-[var(--ink-tertiary)]">
                    {alt.overlap.toString()} token{alt.overlap === 1 ? "" : "s"}
                  </span>
                  <span>
                    {alt.bucket ? (
                      <Stamp variant={bucketVariant(alt.bucket)}>{alt.bucket}</Stamp>
                    ) : (
                      <span className="text-[var(--ink-tertiary)]">—</span>
                    )}
                  </span>
                  <span className="text-right">
                    {alt.score !== null ? alt.score.toFixed(2) : "—"}
                  </span>
                  <span className="text-right">{alt.rank ?? "—"}</span>
                </Link>
              ))}
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  delta,
  suffix,
  fractionDigits,
}: {
  label: string;
  value: string;
  delta: number | null;
  suffix: string;
  fractionDigits: number;
}): JSX.Element {
  const tone = delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  return (
    <Card>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
        {label}
      </h3>
      <p
        className="mt-2 font-display text-[36px] leading-none tabular-nums"
        style={{ fontVariationSettings: "'wght' 500" }}
      >
        {value}
      </p>
      {delta !== null && (
        <p
          className={cn(
            "mt-2 inline-flex items-center gap-1 font-mono text-[11px] tabular-nums",
            tone === "up" && "text-[var(--status-success)]",
            tone === "down" && "text-[var(--status-danger)]",
            tone === "flat" && "text-[var(--ink-tertiary)]",
          )}
        >
          {tone === "up" && <TrendingUp size={11} />}
          {tone === "down" && <TrendingDown size={11} />}
          {delta > 0 ? "+" : ""}
          {delta.toFixed(fractionDigits)}
          {suffix}
        </p>
      )}
    </Card>
  );
}

function MiniChart({
  label,
  help,
  points,
  tone,
}: {
  label: string;
  help: string;
  points: number[];
  tone?: "up" | "down";
}): JSX.Element {
  const allZero = points.every((p) => p === 0);
  return (
    <Card>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
        {label}
      </h3>
      <div className="my-2">
        {allZero ? (
          <div className="h-12 rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
        ) : (
          <Sparkline points={points} height={48} stroke={tone === "up" ? "success" : "ink"} />
        )}
      </div>
      <p className="font-body text-[11px] leading-[1.5] text-[var(--ink-tertiary)]">{help}</p>
    </Card>
  );
}

function ScoreChart({
  signals,
  annotations,
}: {
  signals: KeywordDetailSignal[];
  annotations: KeywordDetailPushAnnotation[];
}): JSX.Element {
  const w = 720;
  const h = 220;
  const pad = { l: 36, r: 12, t: 16, b: 24 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const scores = signals.map((s) => (s.score !== null ? s.score : 0));
  const max = Math.max(...scores, 1);
  const min = 0;
  const xStep = signals.length > 1 ? innerW / (signals.length - 1) : 0;
  const path = signals
    .map((s, i) => {
      const v = s.score !== null ? s.score : 0;
      const x = pad.l + i * xStep;
      const y = pad.t + innerH - ((v - min) / (max - min || 1)) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  // Map annotation date → x coordinate
  const dateToIndex = new Map<string, number>();
  signals.forEach((s, i) => dateToIndex.set(s.date, i));
  const annLines = annotations
    .map((a) => {
      const d = a.pushedAt.slice(0, 10);
      const idx = dateToIndex.get(d) ?? nearestIndex(signals, d);
      if (idx < 0) return null;
      const x = pad.l + idx * xStep;
      return { x, label: `${a.locale} push` };
    })
    .filter((x): x is { x: number; label: string } => x !== null);

  return (
    <svg viewBox={`0 0 ${w.toString()} ${h.toString()}`} className="w-full" style={{ height: `${h.toString()}px` }}>
      {/* y-axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = pad.t + innerH - t * innerH;
        const value = (min + t * (max - min)).toFixed(2);
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
              {value}
            </text>
          </g>
        );
      })}

      {/* annotations */}
      {annLines.map((a, i) => (
        <g key={i}>
          <line
            x1={a.x}
            x2={a.x}
            y1={pad.t}
            y2={h - pad.b}
            stroke="var(--signal)"
            strokeWidth="0.5"
            strokeDasharray="2 3"
          />
          <text
            x={a.x + 3}
            y={pad.t + 9}
            className="fill-[var(--signal)] font-mono"
            fontSize="9"
          >
            {a.label}
          </text>
        </g>
      ))}

      {/* the line itself */}
      <polyline
        points={path}
        fill="none"
        stroke="var(--ink-primary)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* x-axis labels (start/end) */}
      {signals.length > 0 && (
        <>
          <text
            x={pad.l}
            y={h - 6}
            className="fill-[var(--ink-tertiary)] font-mono"
            fontSize="9"
          >
            {signals[0]!.date}
          </text>
          <text
            x={w - pad.r}
            y={h - 6}
            textAnchor="end"
            className="fill-[var(--ink-tertiary)] font-mono"
            fontSize="9"
          >
            {signals[signals.length - 1]!.date}
          </text>
        </>
      )}
    </svg>
  );
}

function nearestIndex(signals: KeywordDetailSignal[], date: string): number {
  const target = new Date(date).getTime();
  let best = -1;
  let bestDiff = Infinity;
  signals.forEach((s, i) => {
    const d = Math.abs(new Date(s.date).getTime() - target);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  });
  return best;
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

