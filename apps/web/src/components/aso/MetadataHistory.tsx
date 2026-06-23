"use client";

import Link from "next/link";
import { useState } from "react";
import { TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import { Card, Stamp, cn } from "@marquee/ui";
import { Sparkline } from "./TradingFloor";

export interface MetadataDiffEntry {
  field: "name" | "subtitle" | "keywordsField" | "promotionalText" | "description" | "shortDescription";
  before: string | null;
  after: string | null;
  addedTokens: string[];
  removedTokens: string[];
}

export interface MetadataHistoryEvent {
  id: string;
  pushedAt: string;
  locale: string;
  snapshot: {
    name: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    shortDescription: string | null;
  };
  diff: MetadataDiffEntry[];
  downloadsBefore7d: number;
  downloadsAfter7d: number;
  downloadDelta: number;
  downloadDeltaPct: number | null;
  pvcrBefore: number;
  pvcrAfter: number;
}

export interface DailySeries {
  date: string;
  downloads: number;
  pvcrPct: number;
}

interface Props {
  tenantSlug: string;
  appId: string;
  range: string;
  windowDays: number;
  events: MetadataHistoryEvent[];
  downloads: DailySeries[];
}

const RANGES = ["30d", "90d", "180d", "365d"] as const;

const FIELD_LABEL: Record<MetadataDiffEntry["field"], string> = {
  name: "Name",
  subtitle: "Subtitle",
  keywordsField: "Keywords field",
  promotionalText: "Promotional",
  description: "Description",
  shortDescription: "Short desc.",
};

export function MetadataHistoryView({ tenantSlug, appId, range, windowDays, events, downloads }: Props): JSX.Element {
  const [filterLocale, setFilterLocale] = useState<string | null>(null);
  const locales = Array.from(new Set(events.map((e) => e.locale))).sort();
  const visible = filterLocale ? events.filter((e) => e.locale === filterLocale) : events;

  return (
    <div className="page-loaded space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-[0.5px] border-[var(--stroke-default)] pb-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            History · push timeline
          </p>
          <h1
            className="mt-1 font-display text-3xl leading-tight tracking-[-0.02em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            What changed, when, and how it moved downloads
          </h1>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`?range=${r}`}
              className={cn(
                "rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em]",
                r === range
                  ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                  : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {r}
            </Link>
          ))}
        </div>
      </header>

      {/* Downloads timeline overlaid with push markers */}
      <Card className="space-y-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Daily downloads · push markers in <span className="text-[var(--signal)]">signal</span>
          </h2>
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {windowDays.toString()}d · {events.length.toString()} push{events.length === 1 ? "" : "es"}
          </span>
        </header>
        {downloads.length === 0 ? (
          <p className="rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-6 text-center font-body text-[12px] text-[var(--ink-tertiary)]">
            No analytics data yet for this window. Once ASC Analytics syncs run, every push event
            in the window will be overlaid as a vertical marker on the downloads chart.
          </p>
        ) : (
          <DownloadsChart downloads={downloads} events={events} />
        )}
      </Card>

      {/* Locale filter */}
      {locales.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setFilterLocale(null)}
            className={cn(
              "rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em]",
              filterLocale === null
                ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
            )}
          >
            All
          </button>
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setFilterLocale(l)}
              className={cn(
                "rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.06em]",
                filterLocale === l
                  ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                  : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      )}

      {/* Events */}
      {visible.length === 0 ? (
        <Card className="border-dashed">
          <p className="font-body text-[13px] text-[var(--ink-secondary)]">
            No metadata pushes recorded in this window. Once you push from the Metadata tab, every
            change is captured here with its 7-day download delta.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {visible.map((event) => (
            <li key={event.id}>
              <EventCard tenantSlug={tenantSlug} appId={appId} event={event} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventCard({
  event,
}: {
  tenantSlug: string;
  appId: string;
  event: MetadataHistoryEvent;
}): JSX.Element {
  const tone = event.downloadDelta > 0 ? "up" : event.downloadDelta < 0 ? "down" : "flat";
  const date = new Date(event.pushedAt);
  return (
    <Card className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <span
            className="font-display text-[22px] leading-none"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
          <Stamp>{event.locale}</Stamp>
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[12px] tabular-nums">
          <span className="text-[var(--ink-tertiary)]">
            7d before: <span className="text-[var(--ink-primary)]">{event.downloadsBefore7d.toLocaleString()}</span>
          </span>
          <ArrowRight size={12} className="text-[var(--ink-tertiary)]" />
          <span className="text-[var(--ink-tertiary)]">
            7d after: <span className="text-[var(--ink-primary)]">{event.downloadsAfter7d.toLocaleString()}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1",
              tone === "up" && "text-[var(--status-success)]",
              tone === "down" && "text-[var(--status-danger)]",
              tone === "flat" && "text-[var(--ink-tertiary)]",
            )}
          >
            {tone === "up" && <TrendingUp size={12} />}
            {tone === "down" && <TrendingDown size={12} />}
            {event.downloadDelta > 0 ? "+" : ""}
            {event.downloadDelta.toLocaleString()}
            {event.downloadDeltaPct !== null && (
              <span>
                ({event.downloadDeltaPct > 0 ? "+" : ""}
                {event.downloadDeltaPct.toFixed(1)}%)
              </span>
            )}
          </span>
        </div>
      </header>

      {/* PVCR before/after */}
      <div className="flex items-baseline gap-6 font-mono text-[11px] text-[var(--ink-tertiary)]">
        <span>
          PVCR <span className="text-[var(--ink-primary)]">{event.pvcrBefore.toFixed(2)}%</span>{" "}
          <ArrowRight size={10} className="inline" />{" "}
          <span className="text-[var(--ink-primary)]">{event.pvcrAfter.toFixed(2)}%</span>
        </span>
      </div>

      {/* Diff body */}
      {event.diff.length === 0 ? (
        <p className="rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-3 font-body text-[12px] text-[var(--ink-tertiary)]">
          No ASO-tracked fields changed in this push (only non-indexed fields moved — e.g. videoUrl, copyright).
        </p>
      ) : (
        <ul className="space-y-3">
          {event.diff.map((d) => (
            <li key={d.field} className="grid grid-cols-1 gap-2 md:grid-cols-[160px_1fr]">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
                {FIELD_LABEL[d.field]}
              </span>
              <div className="space-y-1.5">
                {d.field === "name" || d.field === "subtitle" ? (
                  <div className="font-mono text-[12px]">
                    {d.before && (
                      <p>
                        <span className="text-[var(--ink-tertiary)]">before</span>{" "}
                        <span className="text-[var(--ink-primary)] line-through opacity-70">{d.before}</span>
                      </p>
                    )}
                    {d.after && (
                      <p>
                        <span className="text-[var(--ink-tertiary)]">after</span>{" "}
                        <span className="text-[var(--ink-primary)]">{d.after}</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {d.addedTokens.length === 0 && d.removedTokens.length === 0 ? (
                      <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                        text changed (no token-level diff)
                      </span>
                    ) : (
                      <>
                        {d.addedTokens.slice(0, 18).map((t) => (
                          <Stamp key={`+${t}`} variant="success">
                            +{t}
                          </Stamp>
                        ))}
                        {d.removedTokens.slice(0, 18).map((t) => (
                          <Stamp key={`-${t}`} variant="danger">
                            −{t}
                          </Stamp>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DownloadsChart({
  downloads,
  events,
}: {
  downloads: DailySeries[];
  events: MetadataHistoryEvent[];
}): JSX.Element {
  if (downloads.length === 0) {
    return <Sparkline points={[0]} height={48} stroke="ink" />;
  }
  const w = 960;
  const h = 220;
  const pad = { l: 40, r: 12, t: 14, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const max = Math.max(...downloads.map((d) => d.downloads), 1);
  const min = 0;
  const step = downloads.length > 1 ? innerW / (downloads.length - 1) : 0;
  const path = downloads
    .map((d, i) => {
      const x = pad.l + i * step;
      const y = pad.t + innerH - ((d.downloads - min) / (max - min || 1)) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const dateToIndex = new Map<string, number>();
  downloads.forEach((d, i) => dateToIndex.set(d.date, i));
  const markers = events
    .map((e) => {
      const d = e.pushedAt.slice(0, 10);
      const idx = dateToIndex.get(d) ?? nearestIndex(downloads, d);
      if (idx < 0) return null;
      const x = pad.l + idx * step;
      return { x, locale: e.locale, delta: e.downloadDelta };
    })
    .filter((x): x is { x: number; locale: string; delta: number } => x !== null);

  return (
    <svg viewBox={`0 0 ${w.toString()} ${h.toString()}`} className="w-full" style={{ height: `${h.toString()}px` }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = pad.t + innerH - t * innerH;
        const value = Math.round(min + t * (max - min));
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

      {markers.map((m, i) => (
        <g key={i}>
          <line
            x1={m.x}
            x2={m.x}
            y1={pad.t}
            y2={h - pad.b}
            stroke="var(--signal)"
            strokeWidth="0.6"
            strokeDasharray="2 3"
          />
        </g>
      ))}

      <polyline
        points={path}
        fill="none"
        stroke="var(--ink-primary)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />

      <text x={pad.l} y={h - 4} className="fill-[var(--ink-tertiary)] font-mono" fontSize="9">
        {downloads[0]!.date}
      </text>
      <text
        x={w - pad.r}
        y={h - 4}
        textAnchor="end"
        className="fill-[var(--ink-tertiary)] font-mono"
        fontSize="9"
      >
        {downloads[downloads.length - 1]!.date}
      </text>
    </svg>
  );
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
