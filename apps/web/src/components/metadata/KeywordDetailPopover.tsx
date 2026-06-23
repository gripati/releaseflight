/**
 * KeywordDetailPopover — Astro-focused research dossier.
 *
 * Opened by clicking any keyword chip in the metadata workbench. Four
 * stacked zones, decreasing in importance:
 *
 *   1. HEADLINE      — bucket + recommended action + plain-English
 *                       summary in one card. Always rendered.
 *   2. ASTRO HEALTH  — four-dimension gauge (Demand / Difficulty /
 *                       Trend / Performance). Drops Fit because Fit is
 *                       just the composite score, already implicit in
 *                       the action pill.
 *   3. ASTRO POSITION — big-number rank + Astro-snapshot Δ + 30-day
 *                       position trajectory chart.
 *   4. STRONGER       — alternative keywords in the same storefront
 *                       (when present).
 *
 * Power-user data (score breakdown, raw signal dump) lives in a
 * collapsible "Show analysis details" footer so the popover stays
 * legible for non-ASO readers.
 *
 * Single source of truth: Astro MCP. Apple Search Ads, Google Trends,
 * iTunes Search and the multi-provider fusion layer were retired in
 * the 2026-05 ASO simplification — see docs/16_ASO_INTELLIGENCE.md.
 */
"use client";
import { useEffect, useState } from "react";
import {
  X,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  AlertOctagon,
  AlertTriangle,
  Info as InfoIcon,
} from "lucide-react";
import type { KeywordWarning } from "@marquee/aso";
import { Button, Spinner, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";

export interface KeywordDetailPopoverProps {
  appId: string;
  keywordId: string;
  keywordText: string;
  territory: string;
  /** Optional Apple-rules validation warnings to surface as a panel at
   *  the top of the popover. Set when the popover is opened from a
   *  keywords-field chip — the same token may be flagged for trademark
   *  overlap, plural duplicates, stop words, etc. on top of its Astro
   *  research dossier. Left undefined elsewhere (e.g. Overview), where
   *  the popover only carries Astro data. */
  warnings?: KeywordWarning[];
  onClose: () => void;
}

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
    maxVolume: number | null;
    difficulty: number | null;
  }[];
  breakdown: {
    finalScore: number | null;
    bucket: string | null;
    effectiveWeight: number;
    bucketReason: string;
    components: {
      name: string;
      label: string;
      source: string;
      rawValue: number | null;
      normalised: number | null;
      weight: number;
      contribution: number | null;
      missing: boolean;
    }[];
  };
  analysis: {
    headline: string;
    signalSummary: string;
    recommendedAction: "KEEP" | "PROMOTE" | "SWAP" | "WATCH" | "GATHER_DATA";
    recommendedSlot: "TITLE" | "SUBTITLE" | "KEYWORDS" | "PROMO" | "WATCHLIST" | "REMOVE";
    reasoning: string[];
  };
  suggestedReplacements: {
    id: string;
    keyword: string;
    score: number | null;
    bucket: string | null;
    rank: number | null;
  }[];
}

/**
 * Action chips & their banner styling. We use a LIGHT-TINTED bg so the
 * card body (which carries dark ink text) stays readable; the action
 * pill in the top-right gets a SATURATED accent color so it still
 * pops at a glance.
 */
const ACTION_META: Record<
  DetailResponse["analysis"]["recommendedAction"],
  { label: string; accent: string; bg: string; border: string; pillFg: string }
> = {
  KEEP: {
    label: "Keep",
    accent: "#276749",
    bg: "rgba(56, 161, 105, 0.10)",
    border: "#38A169",
    pillFg: "#FFFFFF",
  },
  PROMOTE: {
    label: "Promote",
    accent: "var(--signal)",
    bg: "rgba(232, 96, 36, 0.08)",
    border: "var(--signal)",
    pillFg: "var(--signal-on)",
  },
  SWAP: {
    label: "Swap out",
    accent: "var(--status-danger)",
    bg: "rgba(229, 62, 62, 0.08)",
    border: "var(--status-danger)",
    pillFg: "#FFFFFF",
  },
  WATCH: {
    label: "Watch",
    accent: "var(--ink-secondary)",
    bg: "var(--surface-tinted)",
    border: "var(--stroke-default)",
    pillFg: "var(--surface-paper)",
  },
  GATHER_DATA: {
    label: "Gather data",
    accent: "#975A16",
    bg: "rgba(214, 158, 46, 0.10)",
    border: "#D69E2E",
    pillFg: "#FFFFFF",
  },
};

const BUCKET_DOT: Record<string, string> = {
  CHAMPION: "#6633EE",
  OPPORTUNITY: "#38A169",
  RISING: "#0EA5E9",
  NEUTRAL: "var(--ink-tertiary)",
  DECAY: "var(--status-danger)",
};

export function KeywordDetailPopover({
  appId,
  keywordId,
  keywordText,
  territory,
  warnings,
  onClose,
}: KeywordDetailPopoverProps): JSX.Element {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-12 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — keyword text + storefront + close. Kept terse so the
            HEADLINE card immediately below carries the real verdict. */}
        <div className="flex items-start justify-between gap-3 border-b-[0.5px] border-[var(--stroke-default)] p-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
              Astro keyword dossier · {territory}
            </p>
            <h2
              className="font-display mt-1 truncate text-[24px] leading-none tracking-[-0.01em]"
              style={{ fontVariationSettings: "'wght' 500" }}
              title={keywordText}
            >
              &ldquo;{keywordText}&rdquo;
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — warnings panel + 4 zones top-to-bottom, decreasing in
         *  importance. The warnings panel sits ABOVE everything else
         *  when present: a chip is most likely being inspected because
         *  the operator saw the red/amber dot on it, so leading with
         *  "here's what's wrong" matches the question they walked in
         *  with. */}
        <div className="space-y-4 p-4">
          {warnings && warnings.length > 0 && <FieldWarningsPanel warnings={warnings} />}

          {loading && (
            <div className="flex items-center gap-2 font-mono text-[12px] text-[var(--ink-tertiary)]">
              <Spinner size={14} /> Loading dossier…
            </div>
          )}

          {err && (
            <p className="font-body rounded-[var(--radius-xs)] border-[0.5px] border-[var(--status-danger)] bg-[var(--status-danger-tint)] px-3 py-2 text-[12px] text-[var(--status-danger)]">
              {err}
            </p>
          )}

          {data && (
            <>
              {/* ZONE 1 — Headline. Bucket + action pill + 1-sentence
                  verdict. The first thing a non-ASO reader sees. */}
              <AnalysisCard analysis={data.analysis} latest={data.latest} />

              {/* ZONE 2 — Astro Health. Four horizontal bars
                  (Demand / Difficulty / Trend / Performance) — every
                  bar sourced from Astro signals. */}
              <HealthGauge
                latest={data.latest}
                history={data.history}
                breakdown={data.breakdown}
                appId={appId}
                keywordText={keywordText}
                territory={territory}
              />

              {/* ZONE 3 — Live App Store position from Astro's
                  search_rankings tool, with 30-day trajectory chart. */}
              <AstroLivePosition appId={appId} keyword={keywordText} store={territory} />

              {/* ZONE 4 — Stronger alternatives, when Astro proposed any. */}
              {data.suggestedReplacements.length > 0 && (
                <SuggestedReplacementsPanel
                  current={{
                    keyword: data.keyword.text,
                    score: data.latest?.score ?? null,
                    bucket: data.latest?.bucket ?? null,
                  }}
                  replacements={data.suggestedReplacements}
                />
              )}

              {/* Power-user data — collapsed by default. */}
              <DossierFooterDetails
                breakdown={data.breakdown}
                latest={data.latest}
                keyword={data.keyword}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t-[0.5px] border-[var(--stroke-default)] px-4 py-3">
          <p className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            Press{" "}
            <kbd className="rounded border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-1.5 py-0.5">
              Esc
            </kbd>{" "}
            to close
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Field warnings panel — Apple-rules validation surfaced at the top
// of the popover when the operator opens the dossier from a chip
// that's been flagged (trademark, plural duplicate, stop word,
// overlap with title/subtitle, etc.).
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ⚠  3 field-rule warnings           19 chars could be freed   │
//   │                                                              │
//   │  ▲ Plural duplicate: "balls" + "ball" — keep the     -5 chars │
//   │      shorter form, Apple indexes both.                       │
//   │  ▲ Stop word: "the" doesn't index in the keywords    -3 chars │
//   │      field — drop it.                                        │
//   │  ⚠ Trademark risk: "Lego" is a third-party mark.    -7 chars │
//   └──────────────────────────────────────────────────────────────┘
//
// The card border + accent dot inherit the WORST severity present:
// danger > warning > info. Each row carries its own severity dot so
// mixed-severity sets still read clearly. `charsSaved` is rendered as
// a per-row tabular pill on the right edge.
// ─────────────────────────────────────────────────────────────────────

const WARNING_TONE: Record<
  KeywordWarning["severity"],
  { fg: string; bg: string; border: string; dot: string; Icon: typeof AlertTriangle; label: string }
> = {
  danger: {
    fg: "var(--status-danger)",
    bg: "var(--status-danger-tint)",
    border: "var(--status-danger)",
    dot: "var(--status-danger)",
    Icon: AlertOctagon,
    label: "Action needed",
  },
  warning: {
    fg: "#975A16",
    bg: "rgba(214, 158, 46, 0.10)",
    border: "var(--status-warning)",
    dot: "var(--status-warning)",
    Icon: AlertTriangle,
    label: "Wasted characters",
  },
  info: {
    fg: "var(--status-info)",
    bg: "var(--status-info-tint)",
    border: "var(--status-info)",
    dot: "var(--status-info)",
    Icon: InfoIcon,
    label: "Optimization tip",
  },
};

function FieldWarningsPanel({ warnings }: { warnings: KeywordWarning[] }): JSX.Element {
  // Worst severity drives the card chrome (border + headline accent).
  // Each individual row still uses its own severity colour so the
  // operator can tell "this one's a trademark risk, this one is just
  // a stop word" at a glance.
  const worst: KeywordWarning["severity"] = warnings.some((w) => w.severity === "danger")
    ? "danger"
    : warnings.some((w) => w.severity === "warning")
      ? "warning"
      : "info";
  const cardTone = WARNING_TONE[worst];
  const totalSaved = warnings.reduce((n, w) => n + w.charsSaved, 0);
  return (
    <section
      role="alert"
      className="overflow-hidden rounded-[var(--radius)] border-[0.5px]"
      style={{ borderColor: cardTone.border, background: cardTone.bg }}
    >
      <header
        className="flex flex-wrap items-center gap-2 px-3 py-2"
        style={{ color: cardTone.fg }}
      >
        <cardTone.Icon size={14} />
        <span className="font-mono text-[10px] font-semibold tracking-[0.10em] uppercase">
          {warnings.length.toString()} field-rule warning
          {warnings.length === 1 ? "" : "s"}
        </span>
        {totalSaved > 0 && (
          <span className="ml-auto rounded-[var(--radius-pill)] bg-[var(--surface-paper)] px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums">
            {totalSaved.toString()} chars could be freed
          </span>
        )}
      </header>
      <ul className="divide-y divide-[var(--stroke-soft)] bg-[var(--surface-paper)]">
        {warnings.map((w, i) => {
          const tone = WARNING_TONE[w.severity];
          return (
            <li key={`${w.code}-${i.toString()}`} className="flex items-start gap-2.5 px-3 py-2">
              <span
                aria-hidden
                className="mt-[5px] block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: tone.dot }}
                title={tone.label}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-[1.4] text-[var(--ink-primary)]">{w.message}</p>
                <p
                  className="mt-0.5 font-mono text-[10px] tracking-[0.06em] uppercase"
                  style={{ color: tone.fg }}
                >
                  {w.code.replaceAll("_", " ").toLowerCase()}
                </p>
              </div>
              {w.charsSaved > 0 && (
                <span
                  className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums"
                  style={{ background: tone.bg, color: tone.fg }}
                  title={`Dropping this token would free ${w.charsSaved.toString()} chars in the field`}
                >
                  -{w.charsSaved.toString()} chars
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Collapsible footer for power-user details — score breakdown table
 * and raw signal dump. Hidden behind a single disclosure so the main
 * popover stays legible. When opened, both sub-sections render at
 * once (they share the same "show me the math" mental model).
 */
function DossierFooterDetails({
  breakdown,
  latest,
  keyword,
}: {
  breakdown: DetailResponse["breakdown"];
  latest: DetailResponse["latest"];
  keyword: DetailResponse["keyword"];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-tinted)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-secondary)] uppercase">
          {open ? "Hide" : "Show"} analysis details
        </span>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
          score breakdown · sources · raw values
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] px-3 py-3">
          <ScoreBreakdownTable breakdown={breakdown} />
          <SignalsRawDump latest={latest} keyword={keyword} />
        </div>
      )}
    </div>
  );
}

function AnalysisCard({
  analysis,
  latest,
}: {
  analysis: DetailResponse["analysis"];
  latest: DetailResponse["latest"];
}): JSX.Element {
  const action = ACTION_META[analysis.recommendedAction];
  const bucketDot = latest?.bucket
    ? (BUCKET_DOT[latest.bucket] ?? "var(--ink-tertiary)")
    : "var(--ink-tertiary)";
  return (
    <div
      className="rounded-[var(--radius)] border-[0.5px] p-4"
      style={{ borderColor: action.border, background: action.bg }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: bucketDot }} />
        <span
          className="font-mono text-[10px] tracking-[0.10em] uppercase"
          style={{ color: action.accent }}
        >
          {latest?.bucket ?? "Unknown"} · Recommended action
        </span>
        <span
          className="ml-auto rounded-[var(--radius-xs)] px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase"
          style={{ background: action.accent, color: action.pillFg }}
        >
          {action.label} → {analysis.recommendedSlot}
        </span>
      </div>
      <h3
        className="font-display mt-2 text-[18px] leading-[1.3]"
        style={{ fontVariationSettings: "'wght' 500" }}
      >
        {analysis.headline}
      </h3>
      <p className="font-body mt-2 text-[13px] leading-[1.55] text-[var(--ink-secondary)]">
        {analysis.signalSummary}
      </p>
      {analysis.reasoning.length > 0 && (
        <ol className="mt-3 space-y-1">
          {analysis.reasoning.map((r, i) => (
            <li
              key={i}
              className="font-body flex gap-2 text-[12px] leading-[1.5] text-[var(--ink-secondary)]"
            >
              <span className="font-mono text-[10px] text-[var(--ink-tertiary)] tabular-nums">
                {(i + 1).toString()}.
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ScoreBreakdownTable({
  breakdown,
}: {
  breakdown: DetailResponse["breakdown"];
}): JSX.Element {
  // Hide empty-data rows by default — the multi-dimensional gauge at
  // the TOP already conveys the headline. Power users can expand to
  // see every signal's contribution + the missing ones.
  const [showAll, setShowAll] = useState(false);
  const presentRows = breakdown.components.filter((c) => !c.missing);
  const missingRows = breakdown.components.filter((c) => c.missing);
  const visibleRows = showAll
    ? breakdown.components
    : presentRows.length > 0
      ? presentRows
      : breakdown.components;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
          Score breakdown · {breakdown.finalScore != null ? breakdown.finalScore.toFixed(2) : "—"}{" "}
          composite
        </h4>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            {(breakdown.effectiveWeight * 100).toFixed(0)}% data coverage
          </span>
          {missingRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-[var(--ink-secondary)] uppercase hover:bg-[var(--surface-tinted)]"
            >
              {showAll
                ? `Hide ${missingRows.length.toString()} empty`
                : `Show ${missingRows.length.toString()} empty`}
            </button>
          )}
        </div>
      </div>
      <p className="font-body mb-2 text-[11px] leading-[1.45] text-[var(--ink-tertiary)]">
        {breakdown.bucketReason}
      </p>
      <div className="overflow-hidden rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)]">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead>
            <tr className="border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              <th className="px-2 py-1.5 text-left">
                <span
                  className="cursor-help"
                  title="The data source feeding this signal — Apple, Google, iTunes or a third-party DB."
                >
                  Signal
                </span>
              </th>
              <th className="px-2 py-1.5 text-right">
                <span
                  className="cursor-help"
                  title="The unmodified value pulled from the source (e.g. Apple popularity 0-5, rank #4, difficulty 67/100)."
                >
                  Raw
                </span>
              </th>
              <th className="px-2 py-1.5 text-right">
                <span
                  className="cursor-help"
                  title="The raw value rescaled to 0.00-1.00 so it can be combined with other signals. Higher is always better."
                >
                  Norm
                </span>
              </th>
              <th className="px-2 py-1.5 text-right">
                <span
                  className="cursor-help"
                  title="How much this signal counts in the composite score (sums to 100% across all signals). Missing signals trigger weight re-balancing."
                >
                  Weight
                </span>
              </th>
              <th className="px-2 py-1.5 text-right">
                <span
                  className="cursor-help"
                  title="weight × normalised — what this signal adds to the final composite score (shown as 100× for readability)."
                >
                  Contribution
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((c) => (
              <tr
                key={c.name}
                className={cn(
                  "border-b-[0.5px] border-[var(--stroke-default)] last:border-b-0",
                  c.missing && "opacity-50",
                )}
                title={c.source}
              >
                <td className="px-2 py-1.5 text-[var(--ink-secondary)]">
                  <div>{c.label}</div>
                  <div className="mt-0.5 font-mono text-[10px] leading-tight text-[var(--ink-tertiary)]">
                    {c.source}
                  </div>
                </td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  title={
                    c.rawValue == null
                      ? "Not pulled yet — credential missing or last sync skipped this signal."
                      : undefined
                  }
                >
                  {c.rawValue == null ? (
                    <span className="cursor-help">—</span>
                  ) : (
                    formatRaw(c.name, c.rawValue)
                  )}
                </td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  title={c.normalised == null ? "Norm computed only when Raw exists." : undefined}
                >
                  {c.normalised == null ? (
                    <span className="cursor-help">—</span>
                  ) : (
                    c.normalised.toFixed(2)
                  )}
                </td>
                <td className="px-2 py-1.5 text-right text-[var(--ink-tertiary)] tabular-nums">
                  {(c.weight * 100).toFixed(0)}%
                </td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  title={
                    c.contribution == null
                      ? "No contribution when raw is missing — this signal's weight re-balances onto the others."
                      : undefined
                  }
                >
                  {c.contribution == null ? (
                    <span className="cursor-help">—</span>
                  ) : (
                    `+${(c.contribution * 100).toFixed(1)}`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-body mt-2 text-[11px] leading-[1.45] text-[var(--ink-tertiary)]">
        Composite = Σ(weight × normalised) / Σ(weight present). Weights re-balance when a signal is
        missing, so a partial dossier still produces a meaningful score.
      </p>
    </div>
  );
}

function formatRaw(name: string, v: number | null | undefined): string {
  if (v == null) return "—";
  if (name === "volume" || name === "difficulty" || name === "maxReachChance") {
    return `${v.toString()}/100`;
  }
  if (name === "volumeShare") return v.toString();
  if (name === "appStoreRank") return `#${v.toString()}`;
  return v.toString();
}

// HistoryChart + Spark removed in the 2026-05 redesign — the
// AstroLivePosition chart below carries the trajectory story on its
// own, and the sparkline bars duplicated information already visible
// in the Health Gauge. The 90-day history array is still available on
// DetailResponse for callers that want it (we use it inside
// `computeDimensions` to derive the local-history trend fallback).

function SuggestedReplacementsPanel({
  current,
  replacements,
}: {
  current: { keyword: string; score: number | null; bucket: string | null };
  replacements: DetailResponse["suggestedReplacements"];
}): JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border-[0.5px] border-[var(--signal)]/40 bg-[var(--surface-elevated)] p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="font-mono text-[10px] tracking-[0.10em] text-[var(--signal)] uppercase">
          Stronger alternatives · same storefront
        </h4>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
          ranked by bucket + score
        </span>
      </div>
      <p className="font-body mb-3 text-[12px] leading-[1.5] text-[var(--ink-secondary)]">
        These keywords outscore <strong>&ldquo;{current.keyword}&rdquo;</strong>
        {current.score != null && current.bucket && (
          <>
            {" "}
            ({current.bucket} · {current.score.toFixed(2)})
          </>
        )}{" "}
        in the same storefront. Open the Metadata workbench → Keywords field to swap one in.
      </p>
      <ul className="space-y-1.5">
        {replacements.map((r, i) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] px-2.5 py-1.5"
          >
            <span className="font-mono text-[10px] text-[var(--ink-tertiary)] tabular-nums">
              #{(i + 1).toString()}
            </span>
            <span
              className="font-display text-[14px]"
              style={{ fontVariationSettings: "'wght' 500" }}
            >
              {r.keyword}
            </span>
            {r.bucket && (
              <span
                className="rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] uppercase"
                style={{
                  background:
                    r.bucket === "CHAMPION"
                      ? "rgba(102, 51, 238, 0.10)"
                      : r.bucket === "OPPORTUNITY"
                        ? "rgba(56, 161, 105, 0.10)"
                        : "rgba(14, 165, 233, 0.10)",
                  color:
                    r.bucket === "CHAMPION"
                      ? "#553C9A"
                      : r.bucket === "OPPORTUNITY"
                        ? "#276749"
                        : "#075985",
                  border: `0.5px solid ${BUCKET_DOT[r.bucket] ?? "var(--stroke-default)"}`,
                }}
              >
                {r.bucket}
              </span>
            )}
            {r.score != null && (
              <span className="font-mono text-[11px] text-[var(--ink-secondary)] tabular-nums">
                score {r.score.toFixed(2)}
              </span>
            )}
            {r.rank != null && (
              <span className="font-mono text-[10px] text-[var(--ink-tertiary)] tabular-nums">
                rank #{r.rank.toString()}
              </span>
            )}
            {current.score != null && r.score != null && (
              <span
                className="ml-auto font-mono text-[10px] tabular-nums"
                style={{ color: "var(--status-success)" }}
                title="Score uplift vs. current keyword"
              >
                +{(r.score - current.score).toFixed(2)} score Δ
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SignalsRawDump({
  latest,
  keyword,
}: {
  latest: DetailResponse["latest"];
  keyword: DetailResponse["keyword"];
}): JSX.Element {
  // Search App Store directly for the term so the user can sanity-
  // check what real users see. Public storefront URL; no auth needed.
  const appStoreSearchUrl = `https://apps.apple.com/${keyword.territory.toLowerCase()}/search?term=${encodeURIComponent(keyword.text)}`;
  return (
    <div>
      <h4 className="mb-2 font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
        Provenance
      </h4>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--ink-secondary)]">
        <li>
          <span className="text-[var(--ink-tertiary)]">Source:</span>{" "}
          <span className="font-medium">{keyword.source.toLowerCase().replace(/_/g, " ")}</span>
        </li>
        <li>
          <span className="text-[var(--ink-tertiary)]">Status:</span>{" "}
          <span className="font-medium">{keyword.status.toLowerCase()}</span>
        </li>
        <li>
          <span className="text-[var(--ink-tertiary)]">Tracked since:</span>{" "}
          <span className="font-medium">{new Date(keyword.createdAt).toLocaleDateString()}</span>
        </li>
        {latest && (
          <li>
            <span className="text-[var(--ink-tertiary)]">Last Astro sync:</span>{" "}
            <span className="font-medium">{latest.date}</span>
          </li>
        )}
        <li className="col-span-2 pt-1.5">
          <a
            href={appStoreSearchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[var(--signal)] underline-offset-4 hover:underline"
          >
            <ExternalLink size={11} />
            Open in the App Store ({keyword.territory})
          </a>
        </li>
      </ul>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Astro live rank + position history
// ──────────────────────────────────────────────────────────────────────

interface AstroRankResponse {
  keyword: string;
  store: string;
  endpoint: string;
  currentRank: number | null;
  previousRank: number | null;
  popularity: number | null;
  difficulty: number | null;
  history: { date: string; rank: number }[];
  capturedAt: string | null;
  notTracked: boolean;
}

/**
 * Live App Store position panel — calls Astro's `search_rankings` tool
 * with `includeHistory: true` so the user sees:
 *
 *   • Where the app ranks RIGHT NOW for this keyword (Astro returns
 *     1000 for "off top-1000"; we render that as "Off chart").
 *   • The delta vs the previous Astro snapshot (↑ 3, ↓ 7, ─).
 *   • A line chart of position history (rank inverted on Y so "up"
 *     = better rank, matching the user's mental model).
 *   • Astro's popularity (0-100) + difficulty (0-100) for context.
 *
 * Fetched on mount, independent from the local DetailResponse load.
 * Empty state when Astro isn't configured (HTTP 503) — keeps the
 * popover usable without an Astro credential.
 */
function AstroLivePosition({
  appId,
  keyword,
  store,
}: {
  appId: string;
  keyword: string;
  store: string;
}): JSX.Element {
  const [data, setData] = useState<AstroRankResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<AstroRankResponse>(
      `/api/v1/apps/${appId}/aso/astro/keyword-rankings?keyword=${encodeURIComponent(keyword)}&store=${encodeURIComponent(store)}`,
    ).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        // 503 with details.kind="ASTRO_NOT_CONFIGURED" → soft empty state
        if (res.message?.toLowerCase().includes("astro")) {
          setNotConfigured(true);
        }
        return;
      }
      setData(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, keyword, store]);

  if (notConfigured) {
    return (
      <div className="rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-4 py-3">
        <p className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
          Astro Position
        </p>
        <p className="font-body mt-1 text-[12px] text-[var(--ink-secondary)]">
          Connect Astro Desktop to surface this keyword's live App Store rank + position history.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] px-4 py-3">
        <Spinner className="h-3 w-3" />
        <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
          Loading Astro position…
        </span>
      </div>
    );
  }

  if (!data) return <></>;

  const rank = data.currentRank;
  const prev = data.previousRank;
  const isOffChart = rank == null || rank >= 1000;
  const delta = rank != null && prev != null ? prev - rank : null;
  // Positive delta = improved (lower rank number). Negative = dropped.
  const trend: "up" | "down" | "flat" | null =
    delta == null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  return (
    <div className="rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] p-4">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
          Astro Position · {data.store}
        </p>
        {data.capturedAt && (
          <p className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            Updated {new Date(data.capturedAt).toLocaleString()}
          </p>
        )}
      </header>

      <div className="grid grid-cols-[auto_1fr] gap-4">
        {/* Big-number rank + delta */}
        <div className="flex flex-col items-start">
          <p className="font-display text-3xl leading-none tabular-nums">
            {isOffChart ? (
              <span className="text-[var(--ink-tertiary)]">off chart</span>
            ) : (
              <>
                <span className="font-mono text-[14px] text-[var(--ink-tertiary)]">#</span>
                {rank.toString()}
              </>
            )}
          </p>
          <div className="mt-1.5 flex items-center gap-1 font-mono text-[11px] text-[var(--ink-secondary)]">
            {trend === "up" && (
              <>
                <TrendingUp size={12} className="text-[var(--status-success)]" />
                <span className="text-[var(--status-success)]">
                  ↑ {Math.abs(delta!).toString()}
                </span>
              </>
            )}
            {trend === "down" && (
              <>
                <TrendingDown size={12} className="text-[var(--status-danger)]" />
                <span className="text-[var(--status-danger)]">↓ {Math.abs(delta!).toString()}</span>
              </>
            )}
            {trend === "flat" && (
              <>
                <Minus size={12} className="text-[var(--ink-tertiary)]" />
                <span>unchanged</span>
              </>
            )}
            {trend === null && (
              <span className="text-[var(--ink-tertiary)]">first observation</span>
            )}
            {prev != null && trend !== null && (
              <span className="text-[var(--ink-tertiary)]">
                · was {prev >= 1000 ? "off" : `#${prev.toString()}`}
              </span>
            )}
          </div>
          {(data.popularity != null || data.difficulty != null) && (
            <div className="mt-3 flex flex-col gap-1 font-mono text-[10px] text-[var(--ink-tertiary)]">
              {data.popularity != null && (
                <span>
                  Popularity{" "}
                  <span className="text-[var(--ink-primary)]">{data.popularity.toString()}</span> /
                  100
                </span>
              )}
              {data.difficulty != null && (
                <span>
                  Difficulty{" "}
                  <span className="text-[var(--ink-primary)]">{data.difficulty.toString()}</span> /
                  100
                </span>
              )}
            </div>
          )}
        </div>

        {/* Position history line chart */}
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
            Position history · {data.history.length.toString()} observation
            {data.history.length === 1 ? "" : "s"}
          </p>
          {data.history.length === 0 ? (
            <p className="font-body text-[12px] text-[var(--ink-tertiary)]">
              No history yet — Astro is still building a baseline.
            </p>
          ) : (
            <PositionHistoryChart points={data.history} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inverted line chart of App Store rank over time. Y axis grows
 * UPWARDS for BETTER ranks (rank 1 = top of chart, rank 1000 = bottom)
 * to match the user's mental model where "going up" means improvement.
 *
 * Rank values >=1000 are clipped to the bottom of the visible band so
 * a single off-chart day doesn't compress the rest of the line.
 */
function PositionHistoryChart({
  points,
}: {
  points: { date: string; rank: number }[];
}): JSX.Element {
  // Map all observations to a stable visual scale. Off-chart (>=1000)
  // is pinned at the bottom; everything else uses a log-ish curve so
  // moves near the top (rank 1-50) get more visual real estate than
  // moves down at rank 800+.
  const ranks = points.map((p) => p.rank);
  const best = Math.min(...ranks, 50);
  const worst = Math.min(1000, Math.max(...ranks, best + 1));
  const range = Math.max(1, worst - best);

  const width = 320;
  const height = 84;
  const pad = 4;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;

  const xs = points.map((_, i) => pad + (i / Math.max(1, points.length - 1)) * usableW);
  const ys = points.map((p) => {
    const clamped = Math.min(worst, Math.max(best, p.rank));
    const t = (clamped - best) / range; // 0 = best
    return pad + t * usableH;
  });

  const linePath = points
    .map((_, i) => `${i === 0 ? "M" : "L"}${xs[i]!.toFixed(1)},${ys[i]!.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${xs[xs.length - 1]!.toFixed(1)},${height - pad} L${xs[0]!.toFixed(1)},${height - pad} Z`;

  return (
    <div>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width.toString()} ${height.toString()}`}
        preserveAspectRatio="none"
        className="overflow-visible"
      >
        {/* Reference grid lines at the top and bottom */}
        <line
          x1={pad}
          x2={width - pad}
          y1={pad}
          y2={pad}
          stroke="var(--stroke-default)"
          strokeDasharray="2 3"
        />
        <line
          x1={pad}
          x2={width - pad}
          y1={height - pad}
          y2={height - pad}
          stroke="var(--stroke-default)"
          strokeDasharray="2 3"
        />
        <path d={areaPath} fill="var(--signal)" opacity={0.12} />
        <path
          d={linePath}
          stroke="var(--signal)"
          strokeWidth={1.5}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xs[i]}
            cy={ys[i]}
            r={2}
            fill="var(--surface-paper)"
            stroke="var(--signal)"
            strokeWidth={1}
          >
            <title>
              {new Date(p.date).toLocaleString()} ·{" "}
              {p.rank >= 1000 ? "off chart" : `#${p.rank.toString()}`}
            </title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--ink-tertiary)] tabular-nums">
        <span>#{best.toString()} (top)</span>
        <span>{worst >= 1000 ? "off chart" : `#${worst.toString()}`}</span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Astro Health Gauge
// ──────────────────────────────────────────────────────────────────────
//
// Composite score (0..1) is too abstract for non-ASO readers. We break
// it into FOUR Astro-sourced dimensions a layperson can read at a glance:
//
//   DEMAND      — how many people search for this term? (Astro popularity)
//   DIFFICULTY  — how hard is it to rank? (Astro difficulty, inverted)
//   TREND       — is the keyword rising or falling? (Astro rank Δ)
//   PERFORMANCE — where do we rank today? (Astro current rank)
//
// FIT was removed in the 2026-05 redesign — it was just our composite
// score, already implicit in the action pill above. Removing it
// halves the visual noise without losing information.
//
// Each dimension produces a 0–100 score with a verdict word (HIGH/EASY/
// RISING/WINNING) so the user can see "Demand HIGH, Difficulty EASY,
// Performance OFF" and immediately know: high-demand term we're not
// ranking for → opportunity.

interface DimensionScore {
  label: string;
  value: number | null; // 0-100, null when no data
  tone: "good" | "ok" | "bad" | "muted"; // colour bucket
  verdict: string; // "HIGH" / "RISING" / "OFF"
  detail: string; // plain-English sentence
  sources: string[]; // ["Apple popularity 65", "Astro volume 3200/5000"]
}

function HealthGauge({
  latest,
  history,
  appId,
  keywordText,
  territory,
}: {
  latest: DetailResponse["latest"];
  history: DetailResponse["history"];
  /** Kept on the signature so future iterations can show per-signal
   *  contribution arrows next to each dimension bar. Unused today. */
  breakdown: DetailResponse["breakdown"];
  appId: string;
  keywordText: string;
  territory: string;
}): JSX.Element {
  // Pull live Astro data in parallel — if available, it overrides the
  // older local-DB signals (Astro is the freshest source for rank +
  // popularity + difficulty).
  const [astro, setAstro] = useState<{
    currentRank: number | null;
    previousRank: number | null;
    popularity: number | null;
    difficulty: number | null;
    historyLen: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{
      currentRank: number | null;
      previousRank: number | null;
      popularity: number | null;
      difficulty: number | null;
      history: { date: string; rank: number }[];
      notTracked: boolean;
    }>(
      `/api/v1/apps/${appId}/aso/astro/keyword-rankings?keyword=${encodeURIComponent(keywordText)}&store=${encodeURIComponent(territory)}`,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && !res.data.notTracked) {
        setAstro({
          currentRank: res.data.currentRank,
          previousRank: res.data.previousRank,
          popularity: res.data.popularity,
          difficulty: res.data.difficulty,
          historyLen: res.data.history.length,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appId, keywordText, territory]);

  const dimensions = computeDimensions(latest, history, astro);

  // Overall verdict: average of the dimensions that have data.
  const present = dimensions.filter((d) => d.value !== null);
  const avg =
    present.length > 0
      ? Math.round(present.reduce((s, d) => s + (d.value ?? 0), 0) / present.length)
      : null;
  const coverage = Math.round((present.length / dimensions.length) * 100);

  const overall: { tone: "good" | "ok" | "bad" | "muted"; label: string } = (() => {
    if (avg == null) return { tone: "muted" as const, label: "Insufficient data" };
    if (avg >= 65) return { tone: "good" as const, label: "Strong keyword" };
    if (avg >= 40) return { tone: "ok" as const, label: "Medium signal" };
    return { tone: "bad" as const, label: "Weak keyword" };
  })();

  return (
    <div className="rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] p-4">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: TONE_COLOR[overall.tone].accent }}
          />
          <p className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
            Astro health · {dimensions.length.toString()} dimensions
          </p>
        </div>
        <div className="flex items-center gap-3">
          {avg != null && (
            <span className="font-display text-[16px] tabular-nums">
              {avg.toString()}
              <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">/100</span>
            </span>
          )}
          <span
            className="rounded-[var(--radius-xs)] px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] uppercase"
            style={{
              background: TONE_COLOR[overall.tone].bg,
              color: TONE_COLOR[overall.tone].accent,
              border: `0.5px solid ${TONE_COLOR[overall.tone].border}`,
            }}
          >
            {overall.label}
          </span>
        </div>
      </header>

      <ul className="space-y-2">
        {dimensions.map((d, i) => (
          <DimensionBar key={i} dim={d} />
        ))}
      </ul>

      <footer className="mt-3 flex items-baseline justify-between gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-2 font-mono text-[10px] text-[var(--ink-tertiary)]">
        <span>
          Coverage: <strong>{coverage.toString()}%</strong>
          {coverage < 50 && <> · run Astro Autopilot to populate missing dimensions</>}
        </span>
        <span>{astro ? "Astro live + snapshot" : "Astro snapshot (live probing…)"}</span>
      </footer>
    </div>
  );
}

/** One horizontal bar in the gauge. */
function DimensionBar({ dim }: { dim: DimensionScore }): JSX.Element {
  const pct = dim.value == null ? 0 : Math.max(0, Math.min(100, dim.value));
  const tone = TONE_COLOR[dim.tone];
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-secondary)] uppercase">
            {dim.label}
          </span>
          <span
            className="font-mono text-[10px] tracking-[0.06em] uppercase"
            style={{ color: tone.accent }}
          >
            {dim.verdict}
          </span>
        </span>
        <span className="font-mono text-[11px] text-[var(--ink-secondary)] tabular-nums">
          {dim.value == null ? "—" : `${dim.value.toString()}/100`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-tinted)]">
        {dim.value != null && (
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct.toString()}%`, background: tone.accent }}
          />
        )}
      </div>
      <p className="font-body mt-1 text-[11px] text-[var(--ink-tertiary)]">{dim.detail}</p>
    </li>
  );
}

const TONE_COLOR: Record<
  "good" | "ok" | "bad" | "muted",
  { accent: string; bg: string; border: string }
> = {
  good: {
    accent: "var(--status-success)",
    bg: "var(--status-success-tint)",
    border: "var(--status-success)",
  },
  ok: {
    accent: "var(--signal)",
    bg: "rgba(232, 96, 36, 0.10)",
    border: "var(--signal)",
  },
  bad: {
    accent: "var(--status-danger)",
    bg: "var(--status-danger-tint)",
    border: "var(--status-danger)",
  },
  muted: {
    accent: "var(--ink-tertiary)",
    bg: "var(--surface-tinted)",
    border: "var(--stroke-default)",
  },
};

/** Synthesise the five dimensions from every signal we have. Each
 *  dimension prefers the freshest source (Astro live > local DB
 *  latest > 90-day history) so the user sees current state, not stale. */
function computeDimensions(
  latest: DetailResponse["latest"],
  history: DetailResponse["history"],
  astro: {
    currentRank: number | null;
    previousRank: number | null;
    popularity: number | null;
    difficulty: number | null;
    historyLen: number;
  } | null,
): DimensionScore[] {
  // ── DEMAND ──────────────────────────────────────────────────────
  // Astro live popularity (0–100) wins; falls back to the persisted
  // Astro snapshot volume from the last analyze run when the live
  // fetch isn't available.
  let demand: DimensionScore;
  const popSources: string[] = [];
  let popVal: number | null = null;
  if (astro?.popularity != null) {
    popVal = astro.popularity;
    popSources.push(`Astro live popularity ${astro.popularity.toString()}/100`);
  } else if (latest?.volume != null) {
    popVal =
      latest.maxVolume != null && latest.maxVolume > 0 && latest.maxVolume !== 100
        ? Math.round((latest.volume / latest.maxVolume) * 100)
        : latest.volume;
    popSources.push(`Astro snapshot popularity ${latest.volume.toString()}/100`);
  }
  if (popVal == null) {
    demand = {
      label: "Demand",
      value: null,
      tone: "muted",
      verdict: "NO DATA",
      detail: "No Astro popularity signal yet. Run Astro Autopilot on the metadata workbench.",
      sources: [],
    };
  } else {
    demand = {
      label: "Demand",
      value: popVal,
      tone: popVal >= 60 ? "good" : popVal >= 30 ? "ok" : "bad",
      verdict: popVal >= 60 ? "HIGH" : popVal >= 30 ? "MEDIUM" : "LOW",
      detail:
        popVal >= 60
          ? "Many people search this term — strong upside if you rank."
          : popVal >= 30
            ? "Modest search volume — worth a keyword slot if intent matches."
            : "Few searches — risky to spend a slot unless it's painkiller intent.",
      sources: popSources,
    };
  }

  // ── DIFFICULTY (inverted: high = easy = good) ───────────────────
  // Astro live difficulty wins; falls back to the persisted snapshot
  // from the last analyze run.
  let difficulty: DimensionScore;
  const diffSources: string[] = [];
  let diffEase: number | null = null;
  if (astro?.difficulty != null) {
    diffEase = 100 - astro.difficulty;
    diffSources.push(`Astro live difficulty ${astro.difficulty.toString()}/100`);
  } else if (latest?.difficulty != null) {
    diffEase = 100 - latest.difficulty;
    diffSources.push(`Astro snapshot difficulty ${latest.difficulty.toString()}/100`);
  }
  if (diffEase == null) {
    difficulty = {
      label: "Difficulty",
      value: null,
      tone: "muted",
      verdict: "NO DATA",
      detail: "No Astro difficulty signal yet. Run Astro Autopilot to populate this dimension.",
      sources: [],
    };
  } else {
    difficulty = {
      label: "Difficulty",
      value: diffEase,
      tone: diffEase >= 65 ? "good" : diffEase >= 40 ? "ok" : "bad",
      verdict: diffEase >= 65 ? "EASY" : diffEase >= 40 ? "MEDIUM" : "HARD",
      detail:
        diffEase >= 65
          ? "Winnable pocket — likely to break into the top 10."
          : diffEase >= 40
            ? "Mid-tier competition — feasible with good metadata."
            : "Crowded — large incumbents will be hard to displace.",
      sources: diffSources,
    };
  }

  // ── TREND ────────────────────────────────────────────────────────
  // Astro rank Δ when available; otherwise compute from our own
  // KeywordSignal score history (which is itself populated by Astro).
  let trend: DimensionScore;
  let trendVal: number | null = null;
  const trendSources: string[] = [];
  if (astro?.currentRank != null && astro.previousRank != null) {
    // Rank IMPROVED (lower number) = trending UP.
    const delta = astro.previousRank - astro.currentRank;
    // Map: +20 positions → +20 trend; -20 → -20; clamp to [-50, 50].
    const clamped = Math.max(-50, Math.min(50, delta));
    trendVal = 50 + clamped; // 0..100
    trendSources.push(
      `Astro rank ${astro.previousRank >= 1000 ? "off" : `#${astro.previousRank.toString()}`} → ${astro.currentRank >= 1000 ? "off" : `#${astro.currentRank.toString()}`}`,
    );
  } else if (history.length >= 2) {
    // Score slope from local history. (oldest first?)
    const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0]?.score;
    const last = sorted[sorted.length - 1]?.score;
    if (first != null && last != null) {
      const delta = last - first;
      trendVal = Math.max(0, Math.min(100, 50 + delta * 100));
      trendSources.push(
        `Score Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)} over ${sorted.length.toString()} samples`,
      );
    }
  }
  if (trendVal == null) {
    trend = {
      label: "Trend",
      value: null,
      tone: "muted",
      verdict: "NO DATA",
      detail: "Need 2+ rank observations to compute a trend.",
      sources: [],
    };
  } else {
    trend = {
      label: "Trend",
      value: Math.round(trendVal),
      tone: trendVal >= 65 ? "good" : trendVal >= 40 ? "ok" : "bad",
      verdict: trendVal >= 65 ? "RISING" : trendVal >= 40 ? "FLAT" : "FALLING",
      detail:
        trendVal >= 65
          ? "Momentum is in your favour — push this slot harder."
          : trendVal >= 40
            ? "Stable interest — neither rising nor falling materially."
            : "Losing ground — investigate why before sinking more slot weight.",
      sources: trendSources,
    };
  }

  // ── PERFORMANCE ──────────────────────────────────────────────────
  // Where do we rank? Astro live wins, then persisted snapshot.
  // FIT dimension was removed in the 2026-05 redesign — it duplicated
  // the composite score already shown in the action pill above.
  let performance: DimensionScore;
  const rank = astro?.currentRank ?? latest?.appStoreRank ?? null;
  if (rank == null || rank >= 1000) {
    performance = {
      label: "Performance",
      value: rank == null ? null : 0,
      tone: rank == null ? "muted" : "bad",
      verdict: rank == null ? "NO DATA" : "OFF CHART",
      detail:
        rank == null
          ? "Astro doesn't know your rank yet — run Astro Autopilot to find out."
          : "Not in the top 1000. If demand is high, this is missed opportunity.",
      sources: [],
    };
  } else {
    // Map: rank 1 → 100, rank 50 → ~70, rank 200 → ~30, rank 1000 → 0.
    const perfVal = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.log10(rank) / 3))));
    performance = {
      label: "Performance",
      value: perfVal,
      tone: perfVal >= 65 ? "good" : perfVal >= 40 ? "ok" : "bad",
      verdict: perfVal >= 65 ? "WINNING" : perfVal >= 40 ? "OK" : "STRUGGLING",
      detail:
        perfVal >= 65
          ? `Top-tier rank (#${rank.toString()}) — this keyword is pulling its weight.`
          : perfVal >= 40
            ? `Mid-tier rank (#${rank.toString()}) — improvable with better slot placement.`
            : `Low rank (#${rank.toString()}) — getting little traffic from this slot.`,
      sources: astro
        ? [`Astro live rank #${rank.toString()}`]
        : [`Astro snapshot rank #${rank.toString()}`],
    };
  }

  return [demand, difficulty, trend, performance];
}
