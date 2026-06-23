"use client";

/**
 * Unified keyword opportunities surface — Phase 3 of the UX refactor.
 *
 * The legacy editor mixed Astro proposals inline with the keywords
 * field (495-LOC AstroProposalsForLocale plus a banner at the page
 * top). The operator was supposed to switch locale in the editor's
 * left rail, then scroll down to see only THAT locale's proposals,
 * then scroll up to see the banner that filtered across all
 * locales. Two views of the same data, both half-finished.
 *
 * Here we collapse both into ONE Linear-style row list:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Filters: [Locale ▾] [Kind ▾] [Source ▾] [Min score ▾]       │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │  ●  ADD    puzzle saga          🇺🇸 en-US        score 0.71  │
 *   │            difficulty 18 · reach 65            [+ Add]        │
 *   │  ●  SWAP   word puzzle → puzzle game   🇺🇸 en-US +0.34       │
 *   │            replace word puzzle (DECAY)            [Apply]    │
 *   │  ●  ADD    bloc smash           🇫🇷 fr-FR · LOCALE_AI         │
 *   │            …                                                 │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Every locale's proposals share one chronologically-aware list. The
 * locale filter chip narrows it. Bulk select lets the operator queue
 * up a sweep across multiple locales at once.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { KEYWORDS_SUBNAV_ACTIONS_ID } from "@/components/shell/KeywordsSubNav";
import {
  Plus,
  ArrowRight,
  RefreshCw,
  AlertCircle,
  Sparkles,
  Filter,
  Search,
} from "lucide-react";
import { Button, Card, Checkbox, Spinner, Stamp, cn } from "@marquee/ui";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import {
  AstroAutopilotProvider,
  useAstroAutopilot,
} from "./astroAutopilot/AstroAutopilotProvider";
import type {
  AstroRecommendByLocale,
  AstroSwapProposal,
} from "./astroAutopilot/types";
import { toast } from "@/components/feedback/Toaster";

interface Props {
  appId: string;
}

export function KeywordsOpportunitiesSurface({ appId }: Props): JSX.Element {
  return (
    <AstroAutopilotProvider appId={appId}>
      <SurfaceInner />
    </AstroAutopilotProvider>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Inner surface — reads provider state
// ──────────────────────────────────────────────────────────────────────

interface Row {
  /** Stable identifier for selection state. */
  id: string;
  locale: string;
  proposal: AstroSwapProposal;
}

type KindFilter = "ALL" | "ADD" | "SWAP";
type LocaleFilter = "ALL" | string;

const MIN_SCORE_OPTIONS = [0, 0.3, 0.5, 0.7] as const;

function SurfaceInner(): JSX.Element {
  const {
    astroConfigured,
    data,
    phase,
    runAnalyze,
    applyLocaleSelection,
    perLocaleAnalyzedAt,
  } = useAstroAutopilot();

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("ALL");
  const [minScore, setMinScore] = useState<number>(0);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  // Locale scope is driven by the sidebar rail via `?locale=…` URL param.
  // Reading it here keeps the surface stateless w.r.t. locale — every
  // tab and reload land on the same view.
  const searchParams = useSearchParams();
  const localeFilter: LocaleFilter = searchParams?.get("locale") ?? "ALL";

  // Flatten every locale's proposals into one row list. Each row keeps
  // its origin locale so the bulk-apply call can group by locale and
  // hit the single per-locale endpoint.
  const allRows: Row[] = useMemo(() => {
    if (!data) return [];
    const out: Row[] = [];
    for (const bucket of data.recommendationsByLocale) {
      bucket.proposals.forEach((p, idx) => {
        out.push({
          id: `${bucket.locale}::${idx.toString()}::${p.strong.keyword}`,
          locale: bucket.locale,
          proposal: p,
        });
      });
    }
    return out;
  }, [data]);

  // `distinctLocales` used to feed the inline locale dropdown; the
  // locale rail now owns that responsibility so we don't need to
  // enumerate them here anymore.

  // Apply filters — search, locale, kind discriminant, score floor.
  const filtered: Row[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (localeFilter !== "ALL" && r.locale !== localeFilter) return false;
      const isSwap =
        r.proposal.kind === "DECAY_AUTO" || r.proposal.kind === "OPPORTUNITY_PREVIEW";
      const isAdd = r.proposal.kind === "OPPORTUNITY_NEW";
      if (kindFilter === "ADD" && !isAdd) return false;
      if (kindFilter === "SWAP" && !isSwap) return false;
      if (q.length > 0) {
        const inStrong = r.proposal.strong.keyword.toLowerCase().includes(q);
        const inWeak = (r.proposal.weak?.keyword ?? "").toLowerCase().includes(q);
        if (!inStrong && !inWeak) return false;
      }
      const score = r.proposal.strong.predictedScore;
      if (score < minScore) return false;
      return true;
    });
  }, [allRows, search, localeFilter, kindFilter, minScore]);

  const totalAcrossAllLocales = allRows.length;
  const anyRunning = phase === "queued" || phase === "running";

  // Bulk apply: pick rows live in `picks`. Group by locale and call the
  // existing apply endpoint per locale so the worker handles the swap
  // / new-add semantics consistently.
  const handleBulkApply = useCallback(async (): Promise<void> => {
    if (picks.size === 0) return;
    setApplying(true);
    const byLocale = new Map<
      string,
      { weakKeyword: string | null; strongKeyword: string }[]
    >();
    for (const id of picks) {
      const row = allRows.find((r) => r.id === id);
      if (!row) continue;
      const arr = byLocale.get(row.locale) ?? [];
      arr.push({
        weakKeyword: row.proposal.weak?.keyword ?? null,
        strongKeyword: row.proposal.strong.keyword,
      });
      byLocale.set(row.locale, arr);
    }
    let appliedTotal = 0;
    let failedTotal = 0;
    for (const [locale, pairs] of byLocale) {
      const r = await applyLocaleSelection(locale, pairs);
      if (r) {
        appliedTotal += r.totalApplied;
      } else {
        failedTotal += pairs.length;
      }
    }
    setApplying(false);
    setPicks(new Set());
    if (failedTotal > 0) {
      toast.error("Some pairs could not apply", {
        description: `${appliedTotal.toString()} applied · ${failedTotal.toString()} failed`,
      });
    } else {
      toast.success(`Applied ${appliedTotal.toString()} keyword change${appliedTotal === 1 ? "" : "s"}`);
    }
  }, [picks, allRows, applyLocaleSelection]);

  if (astroConfigured === false) {
    return <ConfigureCta />;
  }

  return (
    <div className="space-y-4">
      {/* ── Primary actions portal into the sub-nav's right slot ── */}
      <SubnavActions>
        {picks.size > 0 && (
          <>
            <Stamp variant="default">{picks.size.toString()} selected</Stamp>
            <Button variant="ghost" size="sm" onClick={() => setPicks(new Set())}>
              Clear
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleBulkApply()}
              disabled={applying}
            >
              {applying ? <Spinner size={12} /> : <Plus size={12} />}
              Apply {picks.size.toString()}
            </Button>
          </>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runAnalyze()}
          disabled={anyRunning}
          title={
            anyRunning
              ? "An Astro run is in flight — wait for it to finish."
              : "Re-mine Astro across every locale."
          }
        >
          {anyRunning ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {anyRunning ? "Running…" : "Run Astro"}
        </Button>
      </SubnavActions>

      {/* ── Status line ──────────────────────────────────────────── */}
      <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">
        {filtered.length.toString()} of {totalAcrossAllLocales.toString()} opportunity
        {totalAcrossAllLocales === 1 ? "" : "s"} shown
      </p>

      {/* ── Filter row ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5">
          <Search size={12} className="text-[var(--ink-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search keyword"
            className="w-44 bg-transparent font-mono text-[12px] outline-none placeholder:text-[var(--ink-tertiary)]"
          />
        </div>

        {/* Locale scope is driven by the sticky sidebar rail to the
            left of this surface; the dropdown that used to live here
            became redundant once the rail landed. */}

        <FilterSelect
          icon={<Filter size={11} />}
          label="Kind"
          value={kindFilter}
          onChange={(v) => setKindFilter(v as KindFilter)}
          options={[
            { value: "ALL", label: "All" },
            { value: "ADD", label: "Add only" },
            { value: "SWAP", label: "Swap only" },
          ]}
        />

        <FilterSelect
          icon={<Filter size={11} />}
          label="Min score"
          value={minScore.toString()}
          onChange={(v) => setMinScore(Number(v))}
          options={MIN_SCORE_OPTIONS.map((s) => ({
            value: s.toString(),
            label: s === 0 ? "Any" : `≥ ${s.toFixed(1)}`,
          }))}
        />
      </div>

      {/* ── Row list ──────────────────────────────────────────────── */}
      {data == null ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={totalAcrossAllLocales > 0}
          anyRunning={anyRunning}
          onRun={() => void runAnalyze()}
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
          {filtered.map((row) => (
            <RowItem
              key={row.id}
              row={row}
              selected={picks.has(row.id)}
              onToggle={() =>
                setPicks((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                })
              }
              analyzedAt={perLocaleAnalyzedAt[row.locale] ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Row item
// ──────────────────────────────────────────────────────────────────────

function RowItem({
  row,
  selected,
  onToggle,
  analyzedAt,
}: {
  row: Row;
  selected: boolean;
  onToggle: () => void;
  analyzedAt: string | null;
}): JSX.Element {
  const p = row.proposal;
  const isSwap =
    p.kind === "DECAY_AUTO" || p.kind === "OPPORTUNITY_PREVIEW";
  const isAdd = p.kind === "OPPORTUNITY_NEW";
  const territory = row.locale.split(/[-_]/)[1]?.toUpperCase() ?? row.locale.toUpperCase();
  const kindTint = isAdd
    ? { bg: "var(--status-info-tint)", fg: "var(--status-info)" }
    : p.kind === "DECAY_AUTO"
      ? { bg: "var(--status-warning-tint)", fg: "var(--status-warning)" }
      : { bg: "var(--surface-sunken)", fg: "var(--ink-secondary)" };
  return (
    <label
      className={cn(
        "grid cursor-pointer grid-cols-[20px_72px_1fr_auto_auto] items-center gap-4",
        "border-t border-[var(--stroke-soft)] px-4 py-3 transition-colors first:border-t-0",
        selected
          ? "bg-[var(--signal-tint)]"
          : "hover:bg-[var(--surface-tinted)]",
      )}
    >
      <Checkbox checked={selected} onChange={onToggle} />

      {/* Kind pill */}
      <span
        className="inline-flex items-center justify-center rounded-[var(--radius-pill)] px-2 py-1 text-[11px] font-semibold"
        style={{ background: kindTint.bg, color: kindTint.fg }}
      >
        {isAdd ? "Add" : p.kind === "DECAY_AUTO" ? "Auto" : "Swap"}
      </span>

      {/* Keyword + secondary line */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {isSwap && p.weak ? (
            <>
              <span
                className="truncate text-[13px] text-[var(--ink-tertiary)] line-through"
                title={`Replace ${p.weak.keyword}`}
              >
                {p.weak.keyword}
              </span>
              <ArrowRight size={12} className="shrink-0 text-[var(--ink-tertiary)]" />
            </>
          ) : null}
          <span className="truncate text-[14px] font-semibold text-[var(--ink-primary)]">
            {p.strong.keyword}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--ink-tertiary)]">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="text-[13px] leading-none">
              {territoryFlag(territory)}
            </span>
            <span className="font-medium text-[var(--ink-secondary)]">
              {territoryName(territory)}
            </span>
          </span>
          {p.strong.astro.popularity != null && (
            <>
              <span aria-hidden className="text-[var(--ink-quaternary)]">·</span>
              <span>pop {p.strong.astro.popularity.toFixed(0)}</span>
            </>
          )}
          {p.strong.astro.difficulty != null && (
            <>
              <span aria-hidden className="text-[var(--ink-quaternary)]">·</span>
              <span>diff {p.strong.astro.difficulty.toString()}</span>
            </>
          )}
        </p>
      </div>

      {/* Score pill */}
      <span
        className={cn(
          "inline-flex items-center rounded-[var(--radius-pill)] px-2.5 py-1 text-[12px] font-semibold tabular-nums",
          isSwap
            ? "bg-[var(--status-success-tint)] text-[var(--status-success)]"
            : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]",
        )}
        title={isSwap ? "Score uplift over the weak keyword" : "Predicted composite score"}
      >
        {isSwap ? `+${p.scoreDelta.toFixed(2)}` : p.strong.predictedScore.toFixed(2)}
      </span>

      {/* Analyzed-at — small relative-time on md+ */}
      {analyzedAt ? (
        <span
          className="hidden text-[11px] text-[var(--ink-tertiary)] md:inline"
          title={`Analyzed ${new Date(analyzedAt).toLocaleString()}`}
        >
          {relativeAgo(analyzedAt)}
        </span>
      ) : (
        <span />
      )}
    </label>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Auxiliary UI
// ──────────────────────────────────────────────────────────────────────

function FilterSelect({
  icon,
  label,
  value,
  onChange,
  options,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-[12px] transition-colors focus-within:border-[var(--ink-primary)] hover:bg-[var(--surface-tinted)]">
      <span className="text-[var(--ink-tertiary)]" aria-hidden>
        {icon}
      </span>
      <span className="font-medium text-[var(--ink-secondary)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer bg-transparent font-medium text-[var(--ink-primary)] outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SkeletonRows(): JSX.Element {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)]"
        />
      ))}
    </div>
  );
}

function EmptyState({
  hasData,
  anyRunning,
  onRun,
}: {
  hasData: boolean;
  anyRunning: boolean;
  onRun: () => void;
}): JSX.Element {
  return (
    <Card className="border-dashed">
      <div className="flex flex-col items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--surface-tinted)] text-[var(--ink-tertiary)]">
          {hasData ? <Filter size={14} /> : <Sparkles size={14} />}
        </span>
        <div>
          <h3 className="font-display text-[16px] tracking-[-0.005em]">
            {hasData
              ? "No opportunities match your filters"
              : "Astro hasn't mined anything yet"}
          </h3>
          <p className="mt-1 max-w-prose font-body text-[12px] text-[var(--ink-secondary)]">
            {hasData
              ? "Try widening the locale filter, dropping the minimum score, or clearing the kind filter."
              : "Click Run Astro to mine fresh keyword opportunities across every locale. Apple's signal data + AI relevance ranking takes 30-60 seconds per app."}
          </p>
        </div>
        {!hasData && (
          <Button variant="primary" size="sm" onClick={onRun} disabled={anyRunning}>
            {anyRunning ? <Spinner size={12} /> : <RefreshCw size={12} />}
            {anyRunning ? "Running…" : "Run Astro"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ConfigureCta(): JSX.Element {
  return (
    <Card className="border-dashed">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--status-warning-tint)] text-[var(--status-warning)]">
          <AlertCircle size={14} />
        </span>
        <div>
          <h3 className="font-display text-[16px] tracking-[-0.005em]">
            Astro Autopilot not configured
          </h3>
          <p className="mt-1 max-w-prose font-body text-[12px] text-[var(--ink-secondary)]">
            Connect an Astro MCP credential under Settings → Credentials to
            unlock keyword opportunity mining for this workspace.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Compact relative-time renderer. Returns "5m", "2h", "3d", "2w" so
 *  the table stays narrow. Static — no live updates; the surface
 *  re-renders whenever Astro completes a run anyway. */
function relativeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const m = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m.toString()}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h.toString()}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d.toString()}d`;
  const w = Math.floor(d / 7);
  return `${w.toString()}w`;
}

export type { AstroRecommendByLocale };

/**
 * SubnavActions — portal the Opportunities surface's primary CTAs
 * (Run Astro, bulk apply, clear) into the KeywordsSubNav right slot.
 * Mirrors the helper in CompetitorsPanel — kept duplicated rather
 * than extracted so each surface's bundle stays self-contained and
 * the shared id (KEYWORDS_SUBNAV_ACTIONS_ID) is the only contract.
 */
function SubnavActions({ children }: { children: React.ReactNode }): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById(KEYWORDS_SUBNAV_ACTIONS_ID));
  }, []);
  if (!host) return null;
  return createPortal(children, host);
}
