"use client";

/**
 * KeywordChipPopover — anchored research popover for keyword field chips.
 *
 *   ┌─ chip ─┐
 *   │ puzzle │
 *   └────▽───┘
 *       ↓
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ 🇺🇸 United States                                      ✕ │
 *   │ "puzzle"                                  CHAMPION       │
 *   │                                                          │
 *   │ ⚠ 1 field warning · 5 chars freeable        [expand ▾]   │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
 *   │ │POPULARITY│ │DIFFICULTY│ │ POSITION │ │  TREND   │      │
 *   │ │   84     │ │   38     │ │   #12    │ │  ↑ 8     │      │
 *   │ │ ▰▰▰▰▱▱▱  │ │ ▰▰▰▱▱▱▱  │ │ ▰▰▰▰▰▱▱  │ │ ◢       │      │
 *   │ │ /100     │ │  low     │ │ best #4  │ │ 30d      │      │
 *   │ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Position trajectory · last 30 snapshots                 │
 *   │                                                          │
 *   │  #1  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄                    │
 *   │      ╱╲                                                  │
 *   │     ╱  ╲___                                              │
 *   │    ╱      ╲______        _____●                          │
 *   │   ╱             ╲_______╱     ↑ today                    │
 *   │ #40 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌                          │
 *   │     Apr 21          May 5            Today               │
 *   │                                                          │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Astro signal                                             │
 *   │ Strong demand, lightly contested — keep championing.     │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Design notes:
 *   • Anchored to the chip via createPortal + getBoundingClientRect.
 *   • Smart placement-flip when there's no room below.
 *   • 4-tile metric grid: Popularity, Difficulty, Position, Trend.
 *     Each tile carries a thin progress bar that gives a peripheral
 *     read on health without needing to parse the number.
 *   • Full-width line chart with cubic-Bezier smoothing + gradient
 *     fill under the line. Y-axis inverted (#1 at top), gridlines
 *     at top/middle/bottom, date ticks (start / midpoint / today).
 *   • No footer, no "Open full dossier" link — this popover is the
 *     dossier for this surface.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  AlertOctagon,
  AlertTriangle,
  Info as InfoIcon,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import type { KeywordWarning } from "@marquee/aso";
import { Spinner, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";

// ──────────────────────────────────────────────────────────────────────
// Data shape — matches `/api/v1/apps/[id]/aso/keywords/[kwId]/detail`
// ──────────────────────────────────────────────────────────────────────

interface DetailResponse {
  keyword: { id: string; text: string; territory: string };
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
    appStoreRank: number | null;
    score: number | null;
    bucket: string | null;
  }[];
  analysis?: { signalSummary?: string };
}

export interface KeywordChipPopoverProps {
  appId: string;
  /** Tracked-keyword id — used to fetch the Astro detail payload. */
  keywordId: string;
  keywordText: string;
  territory: string;
  warnings: KeywordWarning[];
  /** The chip element this popover anchors to. Required: positioning,
   *  outside-click detection, and caret placement all derive from it. */
  anchor: HTMLElement;
  onClose: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Bucket + warning visual tokens
// ──────────────────────────────────────────────────────────────────────

const BUCKET_TONE: Record<string, { fg: string; bg: string; label: string }> = {
  CHAMPION: { fg: "#6633EE", bg: "rgba(102, 51, 238, 0.10)", label: "Champion" },
  OPPORTUNITY: {
    fg: "var(--status-success)",
    bg: "var(--status-success-tint)",
    label: "Opportunity",
  },
  RISING: { fg: "#0EA5E9", bg: "rgba(14, 165, 233, 0.10)", label: "Rising" },
  NEUTRAL: {
    fg: "var(--ink-secondary)",
    bg: "var(--surface-tinted)",
    label: "Neutral",
  },
  DECAY: {
    fg: "var(--status-danger)",
    bg: "var(--status-danger-tint)",
    label: "Decay",
  },
};

const WARNING_TONE: Record<
  KeywordWarning["severity"],
  { fg: string; bg: string; Icon: typeof AlertTriangle }
> = {
  danger: {
    fg: "var(--status-danger)",
    bg: "var(--status-danger-tint)",
    Icon: AlertOctagon,
  },
  warning: {
    fg: "#975A16",
    bg: "rgba(214, 158, 46, 0.12)",
    Icon: AlertTriangle,
  },
  info: {
    fg: "var(--status-info)",
    bg: "var(--status-info-tint)",
    Icon: InfoIcon,
  },
};

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

const POPOVER_WIDTH = 460;
const POPOVER_GAP = 10;
const VIEWPORT_PADDING = 12;

interface Position {
  top: number;
  left: number;
  placement: "below" | "above";
  /** Arrow X offset *within* the popover, in px from its left edge. */
  arrowX: number;
}

export function KeywordChipPopover({
  appId,
  keywordId,
  keywordText,
  territory,
  warnings,
  anchor,
  onClose,
}: KeywordChipPopoverProps): JSX.Element | null {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [showWarnings, setShowWarnings] = useState(true);

  // ── Fetch keyword detail ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    void api<DetailResponse>(`/api/v1/apps/${appId}/aso/keywords/${keywordId}/detail`).then(
      (res) => {
        if (cancelled) return;
        setLoading(false);
        if (!res.ok) {
          setErr(res.message);
          return;
        }
        setData(res.data);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, keywordId]);

  // ── Position + flip logic ──────────────────────────────────────────
  useLayoutEffect(() => {
    function reposition(): void {
      const el = popoverRef.current;
      if (!el) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popHeight = el.offsetHeight || 360;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;

      const spaceBelow = viewH - anchorRect.bottom;
      const spaceAbove = anchorRect.top;
      const placement: "below" | "above" =
        spaceBelow >= popHeight + POPOVER_GAP + VIEWPORT_PADDING || spaceBelow >= spaceAbove
          ? "below"
          : "above";

      const top =
        placement === "below"
          ? anchorRect.bottom + POPOVER_GAP
          : anchorRect.top - popHeight - POPOVER_GAP;

      const desiredLeft = anchorRect.left + anchorRect.width / 2 - POPOVER_WIDTH / 2;
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(viewW - POPOVER_WIDTH - VIEWPORT_PADDING, desiredLeft),
      );

      const chipCentreX = anchorRect.left + anchorRect.width / 2;
      const arrowX = Math.max(20, Math.min(POPOVER_WIDTH - 20, chipCentreX - left));

      setPosition({ top, left, placement, arrowX });
      setVisible(true);
    }

    reposition();
    const onScroll = (): void => reposition();
    const onResize = (): void => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => reposition());
    if (popoverRef.current) ro.observe(popoverRef.current);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [anchor, data, showWarnings, warnings.length]);

  // ── Dismiss handlers ───────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    function onPointerDown(e: MouseEvent): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (anchor.contains(t)) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [anchor, onClose]);

  if (typeof window === "undefined") return null;

  const bucketKey = data?.latest?.bucket ?? null;
  const bucket = bucketKey ? BUCKET_TONE[bucketKey] : null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Keyword research: ${keywordText}`}
      className={cn(
        "fixed z-[100]",
        "rounded-[var(--radius-lg)] border-[0.5px] border-[var(--stroke-default)]",
        "bg-[var(--surface-elevated)]",
        "shadow-[0_24px_60px_-20px_rgba(0,0,0,0.22),0_8px_18px_-10px_rgba(0,0,0,0.10)]",
        "transition-[opacity,transform] duration-150 ease-out",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
      )}
      style={{
        width: POPOVER_WIDTH,
        maxWidth: "calc(100vw - 24px)",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
      }}
    >
      {/* ── Caret pointing at the source chip ──────────────────────── */}
      {position && <Caret placement={position.placement} xOffset={position.arrowX} />}

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex items-start gap-3 border-b border-[var(--stroke-soft)] px-4 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
            <span aria-hidden className="text-[12px] leading-none">
              {territoryFlag(territory)}
            </span>
            {territoryName(territory)}
          </p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <h3
              className="font-display truncate text-[18px] leading-tight tracking-[-0.005em] text-[var(--ink-primary)]"
              style={{ fontVariationSettings: "'wght' 600" }}
              title={keywordText}
            >
              &ldquo;{keywordText}&rdquo;
            </h3>
            {bucket && (
              <span
                className="rounded-[var(--radius-pill)] px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.06em] uppercase"
                style={{ background: bucket.bg, color: bucket.fg }}
              >
                {bucket.label}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-full p-1 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
        >
          <X size={14} />
        </button>
      </header>

      {/* ── Warnings ───────────────────────────────────────────────── */}
      {warnings.length > 0 && (
        <WarningsBlock
          warnings={warnings}
          open={showWarnings}
          onToggle={() => setShowWarnings((v) => !v)}
        />
      )}

      {/* ── Loading / error states ─────────────────────────────────── */}
      {loading && (
        <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-[var(--ink-tertiary)]">
          <Spinner size={12} /> Pulling Astro signals…
        </div>
      )}

      {err && !loading && (
        <p className="m-4 rounded-[var(--radius)] border border-[var(--status-danger)]/40 bg-[var(--status-danger-tint)] px-2.5 py-1.5 text-[12px] text-[var(--status-danger)]">
          {err}
        </p>
      )}

      {data && !loading && (
        <>
          {/* ── 4-tile metric grid ──────────────────────────────────── */}
          <MetricsGrid latest={data.latest} history={data.history} />

          {/* ── Position trajectory chart ───────────────────────────── */}
          <PositionTrajectory history={data.history} />

          {/* ── Optional analyst one-liner ──────────────────────────── */}
          {data.analysis?.signalSummary && <AnalystOneLiner text={data.analysis.signalSummary} />}
        </>
      )}
    </div>,
    document.body,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Caret — small triangle anchored to the chip
// ──────────────────────────────────────────────────────────────────────

function Caret({
  placement,
  xOffset,
}: {
  placement: "below" | "above";
  xOffset: number;
}): JSX.Element {
  const W = 18;
  const H = 9;
  const path =
    placement === "below"
      ? `M0 ${H.toString()} L${(W / 2).toString()} 0 L${W.toString()} ${H.toString()}`
      : `M0 0 L${(W / 2).toString()} ${H.toString()} L${W.toString()} 0`;
  return (
    <svg
      aria-hidden
      width={W}
      height={H}
      viewBox={`0 0 ${W.toString()} ${H.toString()}`}
      className="absolute"
      style={{
        left: xOffset - W / 2,
        top: placement === "below" ? -H : "auto",
        bottom: placement === "above" ? -H : "auto",
      }}
    >
      <path d={`${path} Z`} fill="var(--surface-elevated)" />
      <path d={path} fill="none" stroke="var(--stroke-default)" strokeWidth="0.5" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Warnings block — collapsible, severity-themed
// ──────────────────────────────────────────────────────────────────────

function WarningsBlock({
  warnings,
  open,
  onToggle,
}: {
  warnings: KeywordWarning[];
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const worst: KeywordWarning["severity"] = warnings.some((w) => w.severity === "danger")
    ? "danger"
    : warnings.some((w) => w.severity === "warning")
      ? "warning"
      : "info";
  const tone = WARNING_TONE[worst];
  const total = warnings.reduce((n, w) => n + w.charsSaved, 0);
  return (
    <section className="border-b border-[var(--stroke-soft)]" style={{ background: tone.bg }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
        style={{ color: tone.fg }}
      >
        <tone.Icon size={13} />
        <span className="font-mono text-[10px] font-semibold tracking-[0.08em] uppercase">
          {warnings.length.toString()} field warning
          {warnings.length === 1 ? "" : "s"}
        </span>
        {total > 0 && (
          <span className="rounded-[var(--radius-pill)] bg-[var(--surface-paper)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums">
            -{total.toString()} chars
          </span>
        )}
        <span className="ml-auto">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-[var(--stroke-soft)] bg-[var(--surface-paper)]">
          {warnings.map((w, i) => {
            const itemTone = WARNING_TONE[w.severity];
            return (
              <li key={`${w.code}-${i.toString()}`} className="flex items-start gap-2 px-4 py-2">
                <span
                  aria-hidden
                  className="mt-[5px] block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: itemTone.fg }}
                />
                <p className="flex-1 text-[12px] leading-snug text-[var(--ink-primary)]">
                  {w.message}
                </p>
                {w.charsSaved > 0 && (
                  <span
                    className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums"
                    style={{ background: itemTone.bg, color: itemTone.fg }}
                  >
                    -{w.charsSaved.toString()}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Metrics grid — 4 Astro signals: Popularity · Difficulty · Position · Trend
// ──────────────────────────────────────────────────────────────────────

type MetricTone = "good" | "neutral" | "warn" | "bad" | "muted";

interface MetricProps {
  label: string;
  value: string;
  /** Sub-line beneath the value — "/100", "low", "best #4", "30d", etc. */
  sub: string;
  /** 0..1 fill ratio for the mini progress bar. `null` hides the bar. */
  fillRatio: number | null;
  tone: MetricTone;
}

function MetricsGrid({
  latest,
  history,
}: {
  latest: DetailResponse["latest"];
  history: DetailResponse["history"];
}): JSX.Element {
  // ── Popularity (volume / maxVolume) ──────────────────────────────
  const popMetric: MetricProps = (() => {
    if (latest?.volume == null) {
      return {
        label: "Popularity",
        value: "—",
        sub: "no signal",
        fillRatio: null,
        tone: "muted",
      };
    }
    const max = latest.maxVolume ?? 100;
    const ratio = max > 0 ? Math.min(1, latest.volume / max) : 0;
    const tone: MetricTone = ratio >= 0.6 ? "good" : ratio >= 0.3 ? "neutral" : "warn";
    return {
      label: "Popularity",
      value: latest.volume.toString(),
      sub: `/ ${max.toString()}`,
      fillRatio: ratio,
      tone,
    };
  })();

  // ── Difficulty (lower = better, so bar fill + colour invert) ─────
  const diffMetric: MetricProps = (() => {
    if (latest?.difficulty == null) {
      return {
        label: "Difficulty",
        value: "—",
        sub: "no signal",
        fillRatio: null,
        tone: "muted",
      };
    }
    const d = latest.difficulty;
    const tone: MetricTone = d <= 35 ? "good" : d <= 65 ? "neutral" : "bad";
    const sub = d <= 35 ? "low" : d <= 65 ? "moderate" : "high";
    return {
      label: "Difficulty",
      value: d.toString(),
      sub,
      fillRatio: Math.min(1, d / 100),
      tone,
    };
  })();

  // ── Position (current App Store rank) ────────────────────────────
  const posMetric: MetricProps = (() => {
    if (latest?.appStoreRank == null) {
      return {
        label: "Position",
        value: "off",
        sub: "not ranked",
        fillRatio: null,
        tone: "muted",
      };
    }
    const r = latest.appStoreRank;
    const tone: MetricTone = r <= 10 ? "good" : r <= 50 ? "neutral" : r <= 100 ? "warn" : "bad";
    const ranked = history.filter((p) => p.appStoreRank != null);
    const best = ranked.length > 0 ? Math.min(...ranked.map((p) => p.appStoreRank!)) : r;
    // Reciprocal scale: #1 ≈ full bar, #100 ≈ near empty. Caps at #200.
    const fillRatio = 1 - Math.min(1, r / 200);
    return {
      label: "Position",
      value: `#${r.toString()}`,
      sub: best === r ? "all-time best" : `best #${best.toString()}`,
      fillRatio,
      tone,
    };
  })();

  // ── Trend (delta of position over the captured window) ───────────
  const trendMetric: MetricProps = (() => {
    const ranked = history.filter((p) => p.appStoreRank != null);
    if (ranked.length < 2) {
      return {
        label: "Trend",
        value: "—",
        sub: "need more data",
        fillRatio: null,
        tone: "muted",
      };
    }
    const first = ranked[0]!.appStoreRank!;
    const last = ranked[ranked.length - 1]!.appStoreRank!;
    const delta = first - last; // positive = improving (rank dropped)
    if (delta === 0) {
      return {
        label: "Trend",
        value: "flat",
        sub: `${history.length.toString()}d window`,
        fillRatio: 0.5,
        tone: "neutral",
      };
    }
    const tone: MetricTone = delta > 0 ? "good" : "bad";
    const arrow = delta > 0 ? "↑" : "↓";
    const mag = Math.abs(delta);
    // Normalise on a log-ish scale — a 5-rank move feels significant
    // when starting from #20, less so from #200. Quick approximation:
    // ratio = min(1, |delta| / max(10, first/3)).
    const norm = Math.min(1, mag / Math.max(10, first / 3));
    // Direction maps onto bar fill: improving → right-half; declining
    // → left-half. Centres at 0.5.
    const fillRatio = delta > 0 ? 0.5 + norm / 2 : 0.5 - norm / 2;
    return {
      label: "Trend",
      value: `${arrow} ${mag.toString()}`,
      sub: `${history.length.toString()}d window`,
      fillRatio,
      tone,
    };
  })();

  return (
    <section className="border-b border-[var(--stroke-soft)] px-4 py-3">
      <div className="grid grid-cols-4 gap-2">
        <MetricTile {...popMetric} />
        <MetricTile {...diffMetric} />
        <MetricTile {...posMetric} />
        <MetricTile {...trendMetric} />
      </div>
    </section>
  );
}

function MetricTile({ label, value, sub, fillRatio, tone }: MetricProps): JSX.Element {
  const accent =
    tone === "good"
      ? "var(--status-success)"
      : tone === "warn"
        ? "var(--status-warning)"
        : tone === "bad"
          ? "var(--status-danger)"
          : tone === "muted"
            ? "var(--ink-tertiary)"
            : "var(--ink-primary)";
  return (
    <div className="rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-paper)] px-2.5 pt-2 pb-2.5">
      <p className="font-mono text-[9px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        {label}
      </p>
      <p
        className="font-display mt-1 truncate text-[18px] leading-none tabular-nums"
        style={{
          color: accent,
          fontVariationSettings: "'wght' 600",
        }}
        title={value}
      >
        {value}
      </p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-tinted)]">
        {fillRatio !== null && (
          <span
            aria-hidden
            className="block h-full rounded-full transition-[width,background-color] duration-300 ease-out"
            style={{
              width: `${(Math.max(0, Math.min(1, fillRatio)) * 100).toString()}%`,
              background: accent,
            }}
          />
        )}
      </div>
      <p className="mt-1.5 truncate font-mono text-[10px] text-[var(--ink-tertiary)]">{sub}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Position trajectory chart — modern smoothed line + gradient fill
// ──────────────────────────────────────────────────────────────────────

function PositionTrajectory({ history }: { history: DetailResponse["history"] }): JSX.Element {
  const ranked = history.filter((p) => p.appStoreRank != null);
  if (ranked.length < 2) {
    return (
      <section className="border-b border-[var(--stroke-soft)] px-4 py-3">
        <h4 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
          Position trajectory
        </h4>
        <div className="rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] px-3 py-4 text-center text-[11px] text-[var(--ink-tertiary)]">
          <TrendingUp size={14} className="mx-auto mb-1 opacity-60" />
          Not enough snapshots for a trend yet.
        </div>
      </section>
    );
  }

  const W = 428;
  const H = 132;
  const PAD_L = 28;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ranks = ranked.map((p) => p.appStoreRank!);
  const observedMin = Math.min(...ranks);
  const observedMax = Math.max(...ranks);
  // Inflate range so a flat/stable keyword still reads as a line in
  // the middle of the chart rather than glued to the top/bottom edge.
  const yMin = Math.max(1, observedMin - 2);
  const yMax = Math.max(observedMax + 2, observedMin + 8);
  const ySpan = yMax - yMin;

  const xOf = (i: number): number => PAD_L + (i / Math.max(1, history.length - 1)) * innerW;
  // Inverted Y — smaller rank goes higher on the chart (#1 at top).
  const yOf = (rank: number): number => PAD_T + ((rank - yMin) / ySpan) * innerH;

  // Build a smoothed path using cubic Beziers between consecutive
  // ranked points, with breaks where the keyword went off-list. Each
  // segment between P_i and P_{i+1} uses control points pulled from
  // the neighbours of P_i and P_{i+1} — a Catmull-Rom-to-Bezier
  // conversion that produces a continuous tangent without overshoot.
  const points: ({ x: number; y: number } | null)[] = history.map((p, i) =>
    p.appStoreRank == null ? null : { x: xOf(i), y: yOf(p.appStoreRank) },
  );

  const segments: string[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p === null) {
      if (current.length > 0) {
        segments.push(buildSmoothPath(current));
        current = [];
      }
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) segments.push(buildSmoothPath(current));

  const linePath = segments.map((s) => s.join(" ")).join(" ");

  // Trend tone — improving = success green, declining = danger red,
  // flat = neutral grey. Drives the line, the gradient stop, and the
  // latest-point dot.
  const first = ranked[0]!.appStoreRank!;
  const last = ranked[ranked.length - 1]!.appStoreRank!;
  const improving = last < first;
  const flat = last === first;
  const lineColor = flat
    ? "var(--ink-tertiary)"
    : improving
      ? "var(--status-success)"
      : "var(--status-danger)";

  // Gradient fill path: take the visible line segments and close each
  // back to the baseline so the gradient renders only beneath the
  // actual data (skips off-list gaps).
  const fillPaths = segments
    .map((seg) => {
      const moves = seg
        .filter((s) => s.startsWith("M") || s.startsWith("C") || s.startsWith("L"))
        .map((s) => s);
      if (moves.length === 0) return null;
      // Pull the first M's coords to close back to baseline on the left.
      const firstMove = moves[0]!;
      const firstParts = firstMove.slice(1).trim().split(/\s+/);
      const firstX = parseFloat(firstParts[0] ?? "0");
      // Find the last commit point — easier to read last coords of last move.
      const lastMove = moves[moves.length - 1]!;
      const lastParts = lastMove.slice(1).trim().split(/\s+/);
      const lastX = parseFloat(lastParts[lastParts.length - 2] ?? "0");
      const base = (H - PAD_B).toFixed(1);
      return `${moves.join(" ")} L ${lastX.toFixed(1)} ${base} L ${firstX.toFixed(1)} ${base} Z`;
    })
    .filter((p): p is string => p !== null)
    .join(" ");

  // Gridlines — pick 3 reference ranks within range so the eye has
  // anchor points (the chart isn't bare). Best/worst observed values
  // are guaranteed to fall inside since yMin/yMax wrap them.
  const gridRanks = [yMin, Math.round((yMin + yMax) / 2), yMax];

  // X-axis ticks — start, midpoint, today.
  // (findLastIndex isn't in the TS lib target we ship — manual reverse
  //  loop avoids the lib bump and works back to ES2015.)
  let lastRankedIdx = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i] !== null) {
      lastRankedIdx = i;
      break;
    }
  }
  const firstRankedIdx = points.findIndex((p) => p !== null);
  const xTicks: { idx: number; label: string }[] = [];
  if (firstRankedIdx >= 0) {
    xTicks.push({
      idx: firstRankedIdx,
      label: formatTickDate(history[firstRankedIdx]!.date),
    });
  }
  const mid = Math.floor(history.length / 2);
  if (mid !== firstRankedIdx && mid !== lastRankedIdx && history[mid]) {
    xTicks.push({ idx: mid, label: formatTickDate(history[mid].date) });
  }
  if (lastRankedIdx >= 0 && lastRankedIdx !== firstRankedIdx) {
    xTicks.push({ idx: lastRankedIdx, label: "Today" });
  }

  // Today's dot — latest valid ranked point.
  const lastPoint = points[lastRankedIdx];

  const gradientId = `kw-trend-gradient-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <section className="border-b border-[var(--stroke-soft)] px-4 py-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
          Position trajectory
        </h4>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
          {history.length.toString()} snapshot{history.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-sunken)]">
        <svg
          viewBox={`0 0 ${W.toString()} ${H.toString()}`}
          className="block h-[132px] w-full"
          role="img"
          aria-label="App Store rank over time"
        >
          {/* Linear gradient that fades the area-under-line from the
              trend colour at top to transparent at the baseline. */}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Y-axis gridlines + labels */}
          {gridRanks.map((r, i) => (
            <g key={`grid-${i.toString()}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={yOf(r)}
                y2={yOf(r)}
                stroke="var(--stroke-soft)"
                strokeWidth={0.5}
                strokeDasharray="3 4"
              />
              <text
                x={PAD_L - 6}
                y={yOf(r) + 3}
                textAnchor="end"
                className="fill-[var(--ink-tertiary)] font-mono"
                style={{ fontSize: 9 }}
              >
                #{Math.round(r).toString()}
              </text>
            </g>
          ))}

          {/* Baseline */}
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={H - PAD_B}
            y2={H - PAD_B}
            stroke="var(--stroke-default)"
            strokeWidth={0.5}
          />

          {/* Area fill under the smoothed line */}
          {fillPaths && <path d={fillPaths} fill={`url(#${gradientId})`} />}

          {/* Main smoothed line */}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={lineColor}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Snapshot dots — small markers at every ranked point so
              the viewer can see where actual snapshots exist vs the
              curve fit. */}
          {points.map((p, i) =>
            p === null ? null : (
              <circle
                key={`pt-${i.toString()}`}
                cx={p.x}
                cy={p.y}
                r={1.6}
                fill={lineColor}
                opacity={i === lastRankedIdx ? 0 : 0.45}
              />
            ),
          )}

          {/* Today's highlighted point — pulsing halo + solid dot */}
          {lastPoint && (
            <>
              <circle cx={lastPoint.x} cy={lastPoint.y} r={6} fill={lineColor} opacity={0.15} />
              <circle
                cx={lastPoint.x}
                cy={lastPoint.y}
                r={3.5}
                fill={lineColor}
                stroke="var(--surface-paper)"
                strokeWidth={1.5}
              />
            </>
          )}

          {/* X-axis ticks */}
          {xTicks.map((t, i) => (
            <text
              key={`xtick-${i.toString()}`}
              x={xOf(t.idx)}
              y={H - 6}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="fill-[var(--ink-tertiary)] font-mono"
              style={{ fontSize: 9 }}
            >
              {t.label}
            </text>
          ))}
        </svg>
      </div>
    </section>
  );
}

/** Catmull-Rom-to-Cubic-Bezier smoother. Takes consecutive ranked
 *  points and emits SVG path commands that curve through every input
 *  point with continuous tangents — much smoother than the default
 *  polyline that connects with straight segments. The tension of 0.5
 *  (default Catmull-Rom) gives a pleasant curve without overshoot. */
function buildSmoothPath(points: { x: number; y: number }[]): string[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    return [`M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`];
  }
  const cmds: string[] = [];
  cmds.push(`M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`);
  // For each segment, derive control points from neighbours.
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    // Catmull-Rom → Bezier conversion. The /6 factor is the standard
    // tension that produces a smooth, snug curve.
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    cmds.push(
      `C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    );
  }
  return cmds;
}

/** Short date label for x-axis ticks. Returns "Apr 21" style strings;
 *  expects ISO YYYY-MM-DD input. */
function formatTickDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ──────────────────────────────────────────────────────────────────────
// Analyst one-liner — single sentence from the Astro engine
// ──────────────────────────────────────────────────────────────────────

function AnalystOneLiner({ text }: { text: string }): JSX.Element {
  return (
    <section className="px-4 py-3">
      <p className="mb-1 font-mono text-[9px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        Astro signal
      </p>
      <p className="text-[12px] leading-snug text-[var(--ink-secondary)]">{text}</p>
    </section>
  );
}
