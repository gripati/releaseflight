"use client";

/**
 * Centred modal popup that shows a keyword's detail without leaving
 * the current page. Triggered by clicking a keyword in any of the
 * territory grid surfaces (portfolio cards, per-app daily check,
 * popover overflow lists).
 *
 * Fetches `/api/v1/apps/[id]/keywords/[kwId]/detail` on open.
 * Renders a focused, compact view:
 *   • header — keyword + flag/territory + close
 *   • latest stats grid — rank, score, volume, difficulty, max reach
 *   • mini sparkline of recent rank trend (last 30 entries)
 *   • analysis sentence from the API (plain-English signal summary)
 *   • footer — link to the full keyword-detail page for deeper drill-in
 *
 * No route change; all interaction lives inside the dialog.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@marquee/ui";
import { territoryFlag, territoryName } from "@marquee/core/locale";

interface DetailResponse {
  keyword: {
    id: string;
    text: string;
    territory: string;
    source: string;
    status: string;
    notes: string | null;
    createdAt: string;
  };
  latest: {
    date: string;
    score: number | null;
    bucket: string | null;
    appStoreRank: number | null;
    volume: number | null;
    maxVolume: number | null;
    difficulty: number | null;
    maxReachChance: number | null;
  } | null;
  history: {
    date: string;
    score: number | null;
    bucket: string | null;
    appStoreRank: number | null;
    volume: number | null;
    difficulty: number | null;
  }[];
  analysis?: {
    signalSummary?: string;
  };
}

export type ModalRange = "1d" | "7d" | "14d" | "30d" | "90d";

const RANGE_LABELS: Record<ModalRange, string> = {
  "1d": "Today vs yesterday",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

interface KeywordDetailModalProps {
  tenantSlug: string;
  appId: string;
  trackedKeywordId: string;
  /** Optimistic header — shown immediately so the modal isn't blank
   *  while the fetch is in flight. Caller knows the keyword + territory
   *  from the row that triggered this. */
  initialKeyword: string;
  initialTerritory: string;
  /** Date window driving the fetched signals + chart. Defaults to 90d
   *  so the chart always has shape even when launched outside the
   *  portfolio range filter. */
  range?: ModalRange;
  onClose: () => void;
}

export function KeywordDetailModal({
  tenantSlug,
  appId,
  trackedKeywordId,
  initialKeyword,
  initialTerritory,
  range: rangeProp = "90d",
  onClose,
}: KeywordDetailModalProps): JSX.Element {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local range state so the user can re-pick a different window
  // inside the modal without reopening it. Defaults to whatever
  // came from the page filter.
  const [range, setRange] = useState<ModalRange>(rangeProp);

  // Fetch detail whenever the range changes. AbortController lets us
  // cancel if the modal is dismissed (or the user clicks a different
  // range) mid-flight so we don't render stale data.
  useEffect(() => {
    setData(null);
    setError(null);
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/apps/${appId}/keywords/${trackedKeywordId}/detail?range=${range}`,
          { credentials: "include", signal: ac.signal },
        );
        if (!res.ok) {
          setError(`HTTP ${res.status.toString()}`);
          return;
        }
        const json = (await res.json()) as DetailResponse;
        setData(json);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => ac.abort();
  }, [appId, trackedKeywordId, range]);

  // ESC closes; lock body scroll while open so the page underneath
  // doesn't scroll behind the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const keyword = data?.keyword.text ?? initialKeyword;
  const territory = data?.keyword.territory ?? initialTerritory;

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kw-modal-title"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(600px,92vw)]",
          "-translate-x-1/2 -translate-y-1/2",
          "flex flex-col rounded-[var(--radius-sm)] border border-[var(--stroke-default)]",
          "bg-[var(--surface-paper)] shadow-2xl",
        )}
      >
        {/* Header — present immediately, even while loading */}
        <header className="flex items-baseline gap-2 border-b border-[var(--stroke-default)] px-4 py-3">
          <span className="text-base" aria-hidden>
            {territoryFlag(territory)}
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="kw-modal-title" className="truncate font-display text-base">
              {keyword}
            </h3>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
              {territoryName(territory)}
              {data?.latest?.bucket ? (
                <span className="ml-2 normal-case text-[var(--ink-secondary)]">
                  {data.latest.bucket}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
          >
            Close
          </button>
        </header>

        {/* In-modal range switcher — lets the user broaden / narrow
            the window without leaving the modal. Refetches /detail. */}
        <div className="flex items-center gap-2 border-b border-[var(--stroke-default)] bg-[var(--surface-paper)] px-4 py-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
            Range
          </span>
          <div className="flex items-center gap-0.5 rounded-[var(--radius-xs)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-0.5">
            {(["1d", "7d", "14d", "30d", "90d"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={range === r}
                className={cn(
                  "rounded-[var(--radius-xs)] px-2 py-0.5 text-[10px] font-medium leading-none transition-colors",
                  range === r
                    ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                    : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
                )}
              >
                {r === "1d" ? "Today" : r}
              </button>
            ))}
          </div>
          <span className="ml-auto font-mono text-[10px] text-[var(--ink-tertiary)]">
            {RANGE_LABELS[range]}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <ErrorBlock message={error} />
          ) : !data ? (
            <SkeletonBlock />
          ) : (
            <DetailBody data={data} range={range} />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--stroke-default)] px-4 py-2">
          <Link
            href={`/t/${tenantSlug}/apps/${appId}/keywords/${trackedKeywordId}`}
            className="rounded-[var(--radius-xs)] bg-[var(--ink-primary)] px-3 py-1 text-[11px] font-medium text-[var(--surface-paper)] hover:opacity-90"
          >
            Open full detail →
          </Link>
        </footer>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Body — current-status hero + full line chart + secondary stats
// ─────────────────────────────────────────────────────────────────────

function DetailBody({ data, range }: { data: DetailResponse; range: ModalRange }): JSX.Element {
  const latest = data.latest;

  // The hero "vs" anchor depends on the selected range:
  //   • range=1d  → previous snapshot (yesterday)
  //   • range>1d  → earliest snapshot in the window
  // That way the user sees "today vs N days ago" instead of always
  // "today vs yesterday" when they've broadened the window.
  const prev =
    range === "1d"
      ? data.history.length >= 2
        ? (data.history[data.history.length - 2] ?? null)
        : null
      : (data.history[0] ?? null);

  return (
    <div className="space-y-4">
      <CurrentStatusHero latest={latest} prev={prev} range={range} />

      {/* Full-size rank line chart */}
      <section>
        <div className="mb-1.5 flex items-baseline gap-2">
          <h4 className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
            Rank over {RANGE_LABELS[range].toLowerCase()}
          </h4>
          <span className="font-mono text-[9px] text-[var(--ink-tertiary)]">
            ({data.history.length.toString()} snapshots)
          </span>
        </div>
        {data.history.length === 0 ? (
          <p className="text-[11px] text-[var(--ink-tertiary)]">
            No history yet — Astro hasn&apos;t snapshotted this keyword.
          </p>
        ) : (
          <RankLineChart history={data.history} />
        )}
      </section>

      {/* Secondary metrics — score, popularity, difficulty, max reach */}
      <SecondaryStats latest={latest} prev={prev} />

      {/* Analyst sentence */}
      {data.analysis?.signalSummary ? (
        <section>
          <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
            Analyst note
          </h4>
          <p className="text-[12px] leading-snug text-[var(--ink-secondary)]">
            {data.analysis.signalSummary}
          </p>
        </section>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Hero — big current rank + delta vs previous + bucket
// ─────────────────────────────────────────────────────────────────────

function CurrentStatusHero({
  latest,
  prev,
  range,
}: {
  latest: DetailResponse["latest"];
  prev: DetailResponse["history"][number] | null;
  range: ModalRange;
}): JSX.Element {
  // Human-readable "vs ..." anchor — what does "prev" represent?
  // For 1d it's literally yesterday; for wider windows it's "N days ago".
  const vsLabel =
    range === "1d"
      ? "yesterday"
      : range === "7d"
        ? "7 days ago"
        : range === "14d"
          ? "14 days ago"
          : range === "30d"
            ? "30 days ago"
            : "90 days ago";
  if (!latest) {
    return (
      <section className="rounded-[var(--radius-sm)] border border-dashed border-[var(--stroke-default)] px-4 py-3 text-center">
        <p className="text-[12px] text-[var(--ink-tertiary)]">
          No recent signal. Run Astro Autopilot to populate data.
        </p>
      </section>
    );
  }

  const todayRank = latest.appStoreRank;
  const prevRank = prev?.appStoreRank ?? null;
  const delta = todayRank != null && prevRank != null ? prevRank - todayRank : null;
  const direction: "up" | "down" | "exited" | "entered" | "same" | null =
    todayRank == null && prevRank != null
      ? "exited"
      : todayRank != null && prevRank == null
        ? "entered"
        : delta == null
          ? null
          : delta > 0
            ? "up"
            : delta < 0
              ? "down"
              : "same";

  const heroTone =
    direction === "up" || direction === "entered"
      ? "tone-positive"
      : direction === "down" || direction === "exited"
        ? "tone-negative"
        : "";

  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--stroke-default)] bg-[var(--surface-tinted)]/40 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
          Current rank
        </span>
        <span className="font-mono text-[9px] text-[var(--ink-tertiary)]">
          {latest.date}
        </span>
        {latest.bucket ? (
          <span className="ml-auto rounded-[var(--radius-xs)] bg-[var(--surface-paper)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
            {latest.bucket}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-3">
        {/* Big current rank */}
        <span
          className={cn(
            "font-display text-4xl font-semibold leading-none tabular-nums",
            todayRank == null ? "text-[var(--ink-tertiary)]" : "",
          )}
        >
          {todayRank == null ? "off" : `#${todayRank.toString()}`}
        </span>
        {/* Delta vs prev snapshot */}
        {direction && direction !== "same" ? (
          <span className={cn("font-mono text-[12px] tabular-nums", heroTone)}>
            {direction === "exited"
              ? `↓ from #${(prevRank ?? 0).toString()} (${vsLabel})`
              : direction === "entered"
                ? `↑ new entry vs ${vsLabel}`
                : delta != null && delta > 0
                  ? `↑ ${delta.toString()} from #${(prevRank ?? 0).toString()} (${vsLabel})`
                  : delta != null
                    ? `↓ ${Math.abs(delta).toString()} from #${(prevRank ?? 0).toString()} (${vsLabel})`
                    : ""}
          </span>
        ) : direction === "same" && prevRank != null ? (
          <span className="font-mono text-[12px] text-[var(--ink-tertiary)]">
            same as {vsLabel}
          </span>
        ) : null}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Secondary stats — score / popularity / difficulty / max reach + delta
// ─────────────────────────────────────────────────────────────────────

function SecondaryStats({
  latest,
  prev,
}: {
  latest: DetailResponse["latest"];
  prev: DetailResponse["history"][number] | null;
}): JSX.Element {
  if (!latest) return <></>;
  return (
    <section>
      <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
        Signal breakdown
      </h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Score"
          value={latest.score != null ? latest.score.toFixed(2) : "—"}
          deltaText={fmtDelta(latest.score, prev?.score, (v) => v.toFixed(2))}
          deltaPositive={
            latest.score != null && prev?.score != null ? latest.score > prev.score : null
          }
        />
        <Stat
          label="Popularity"
          value={latest.volume != null ? latest.volume.toString() : "—"}
          sub={latest.maxVolume != null ? `/ ${latest.maxVolume.toString()}` : undefined}
          deltaText={fmtDelta(latest.volume, prev?.volume, (v) => v.toString())}
          deltaPositive={
            latest.volume != null && prev?.volume != null
              ? latest.volume > prev.volume
              : null
          }
        />
        <Stat
          label="Difficulty"
          value={latest.difficulty != null ? latest.difficulty.toString() : "—"}
          tone={
            latest.difficulty == null
              ? "muted"
              : latest.difficulty <= 35
                ? "positive"
                : latest.difficulty <= 65
                  ? "neutral"
                  : "negative"
          }
          deltaText={fmtDelta(latest.difficulty, prev?.difficulty, (v) => v.toString())}
          // Lower difficulty = better, so invert the green/red.
          deltaPositive={
            latest.difficulty != null && prev?.difficulty != null
              ? latest.difficulty < prev.difficulty
              : null
          }
        />
        <Stat
          label="Max reach"
          value={latest.maxReachChance != null ? latest.maxReachChance.toString() : "—"}
          tone={
            latest.maxReachChance == null
              ? "muted"
              : latest.maxReachChance >= 40
                ? "positive"
                : latest.maxReachChance >= 20
                  ? "neutral"
                  : "negative"
          }
        />
      </div>
    </section>
  );
}

function fmtDelta(
  cur: number | null | undefined,
  prev: number | null | undefined,
  fmt: (v: number) => string,
): string | undefined {
  if (cur == null || prev == null) return undefined;
  const d = cur - prev;
  if (d === 0) return undefined;
  const sign = d > 0 ? "+" : "";
  return `${sign}${fmt(d)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Stat tile
// ─────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  tone,
  deltaText,
  deltaPositive,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "neutral" | "muted";
  /** Optional "+0.05" / "−12" delta annotation under the value. */
  deltaText?: string;
  /** When deltaText is set, this picks the tone. `null` = muted. */
  deltaPositive?: boolean | null;
}): JSX.Element {
  const valueClass =
    tone === "positive"
      ? "tone-positive"
      : tone === "negative"
        ? "tone-negative"
        : tone === "muted"
          ? "text-[var(--ink-tertiary)]"
          : "";
  const deltaClass =
    deltaPositive === true
      ? "tone-positive"
      : deltaPositive === false
        ? "tone-negative"
        : "text-[var(--ink-tertiary)]";
  return (
    <div className="rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={cn("font-display text-base tabular-nums", valueClass)}>{value}</span>
        {sub ? (
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">{sub}</span>
        ) : null}
      </div>
      {deltaText ? (
        <div className={cn("mt-0.5 font-mono text-[9px] tabular-nums", deltaClass)}>
          {deltaText}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rank line chart — labeled axes, gridlines, today's point highlighted
// ─────────────────────────────────────────────────────────────────────

function RankLineChart({
  history,
}: {
  history: DetailResponse["history"];
}): JSX.Element {
  // Only ranked points contribute to the line. Off-list days are
  // rendered as breaks (path moves to next valid point with `M`,
  // not `L`, so the line doesn't dishonestly bridge gaps).
  if (history.every((p) => p.appStoreRank == null)) {
    return (
      <p className="text-[11px] text-[var(--ink-tertiary)]">
        Keyword has been off-list across the whole window.
      </p>
    );
  }

  // Chart geometry. SVG uses a viewBox so it scales responsively;
  // we draw at 600×180 logical units.
  const W = 600;
  const H = 180;
  const PAD_L = 30; // left padding for rank labels
  const PAD_R = 12;
  const PAD_T = 10;
  const PAD_B = 22; // bottom padding for date labels

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Pick the Y range based on what's in the history — but clamp to
  // a minimum of #1..#50 so a stable keyword doesn't look like wild
  // swings just because its rank only moved 2 positions.
  const ranks = history
    .map((p) => p.appStoreRank)
    .filter((r): r is number => r != null);
  const observedMin = Math.min(...ranks);
  const observedMax = Math.max(...ranks);
  // Inflate range so we have visible breathing room.
  const yMin = Math.max(1, observedMin - 2);
  const yMax = Math.max(observedMax + 5, observedMin + 10, 25);
  const ySpan = yMax - yMin;

  const xOf = (i: number): number =>
    PAD_L + (i / Math.max(1, history.length - 1)) * innerW;
  // Inverted: smaller rank = higher on chart (#1 at top).
  const yOf = (rank: number): number =>
    PAD_T + ((rank - yMin) / ySpan) * innerH;

  // Build the path. Gaps (off-list days) start a new sub-path so the
  // line breaks instead of jumping straight across empty stretches.
  const pathSegments: string[] = [];
  let inSegment = false;
  history.forEach((p, i) => {
    if (p.appStoreRank == null) {
      inSegment = false;
      return;
    }
    const cmd = inSegment ? "L" : "M";
    pathSegments.push(`${cmd} ${xOf(i).toFixed(1)} ${yOf(p.appStoreRank).toFixed(1)}`);
    inSegment = true;
  });
  const path = pathSegments.join(" ");

  // Gridlines at nice rank values within range.
  const candidateLines = [1, 3, 10, 25, 50, 100, 200].filter(
    (r) => r >= yMin && r <= yMax,
  );

  // Highlight today's data point (last ranked point) with a filled
  // dot — eye lands there first.
  const lastRanked = [...history].reverse().find((p) => p.appStoreRank != null);
  const firstRanked = history.find((p) => p.appStoreRank != null);
  const improving =
    lastRanked && firstRanked && lastRanked.appStoreRank! < firstRanked.appStoreRank!;
  const lineColor = improving ? "var(--status-success)" : "var(--status-danger)";

  // X-axis date ticks — first, middle, last.
  const ticks = [0, Math.floor((history.length - 1) / 2), history.length - 1]
    .filter((i, idx, arr) => arr.indexOf(i) === idx && i < history.length);

  return (
    <div className="rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] bg-[var(--surface-paper)] p-2">
      <svg
        viewBox={`0 0 ${W.toString()} ${H.toString()}`}
        className="h-44 w-full"
        role="img"
        aria-label="Rank over time line chart"
      >
        {/* Gridlines + rank labels */}
        {candidateLines.map((r) => (
          <g key={r}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yOf(r)}
              y2={yOf(r)}
              stroke="var(--stroke-soft)"
              strokeWidth={0.5}
              strokeDasharray="2 3"
            />
            <text
              x={PAD_L - 4}
              y={yOf(r) + 3}
              textAnchor="end"
              className="fill-[var(--ink-tertiary)] font-mono"
              style={{ fontSize: 9 }}
            >
              #{r.toString()}
            </text>
          </g>
        ))}

        {/* Axis baseline */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={H - PAD_B}
          y2={H - PAD_B}
          stroke="var(--stroke-default)"
          strokeWidth={0.5}
        />

        {/* Rank line */}
        {path ? (
          <path
            d={path}
            fill="none"
            stroke={lineColor}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* All-points subtle markers — gives "where snapshots
            actually exist" without crowding the line. */}
        {history.map((p, i) =>
          p.appStoreRank != null ? (
            <circle
              key={i}
              cx={xOf(i)}
              cy={yOf(p.appStoreRank)}
              r={1.5}
              fill={lineColor}
              opacity={0.4}
            />
          ) : null,
        )}

        {/* Today's highlighted point */}
        {lastRanked ? (
          <circle
            cx={xOf(history.indexOf(lastRanked))}
            cy={yOf(lastRanked.appStoreRank!)}
            r={3.5}
            fill={lineColor}
            stroke="var(--surface-paper)"
            strokeWidth={1.5}
          />
        ) : null}

        {/* X-axis date ticks */}
        {ticks.map((i) => {
          const p = history[i]!;
          return (
            <text
              key={i}
              x={xOf(i)}
              y={H - PAD_B + 12}
              textAnchor={i === 0 ? "start" : i === history.length - 1 ? "end" : "middle"}
              className="fill-[var(--ink-tertiary)] font-mono"
              style={{ fontSize: 9 }}
            >
              {p.date}
            </text>
          );
        })}
      </svg>

      {/* Tiny legend strip below the chart — best/worst summary */}
      <div className="mt-1 flex justify-between font-mono text-[9px] text-[var(--ink-tertiary)]">
        <span>
          best <span className="text-[var(--ink-secondary)]">#{observedMin.toString()}</span>
        </span>
        <span>
          worst <span className="text-[var(--ink-secondary)]">#{observedMax.toString()}</span>
        </span>
        <span>
          {lastRanked ? (
            <>
              today{" "}
              <span
                style={{ color: lineColor }}
                className="font-semibold"
              >
                #{lastRanked.appStoreRank!.toString()}
              </span>
            </>
          ) : (
            "today off"
          )}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Loading + error placeholders
// ─────────────────────────────────────────────────────────────────────

function SkeletonBlock(): JSX.Element {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-12 rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)]"
          />
        ))}
      </div>
      <div className="h-14 rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
      <div className="h-8 rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]" />
    </div>
  );
}

function ErrorBlock({ message }: { message: string }): JSX.Element {
  return (
    <div className="rounded-[var(--radius-xs)] border border-[var(--status-danger)] px-3 py-2 text-[12px]">
      <span className="tone-negative font-medium">Failed to load:</span>{" "}
      <span className="text-[var(--ink-secondary)]">{message}</span>
    </div>
  );
}
