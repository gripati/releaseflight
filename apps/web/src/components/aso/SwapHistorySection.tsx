"use client";

/**
 * Chronological log of every keyword swap on this app.
 *
 * Fetches /api/v1/apps/[id]/aso/keywords/swap-history on mount. Each
 * row reads as one editorial line: "On Mar 14, you replaced 'puzzle
 * game' (#42 · DECAY) with 'merge puzzle' in 🇺🇸 US — now #12."
 *
 * Compact 1-row-per-swap layout with date on the left, old → new in
 * the middle, current rank chip on the right. Optional territory
 * filter chip group at the top.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@marquee/ui";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import { RankChange } from "./RankChange";

interface SwapRow {
  id: string;
  date: string;
  territory: string;
  tags: string[];
  notes: string | null;
  newKeyword: {
    id: string;
    keyword: string;
    rank: number | null;
    score: number | null;
    bucket: string | null;
  };
  oldKeyword: {
    id: string;
    keyword: string;
    rank: number | null;
    score: number | null;
    bucket: string | null;
    replacedAt: string | null;
  } | null;
}

interface SwapHistorySectionProps {
  appId: string;
}

export function SwapHistorySection({ appId }: SwapHistorySectionProps): JSX.Element {
  const [rows, setRows] = useState<SwapRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [territoryFilter, setTerritoryFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    const url = new URL(
      `/api/v1/apps/${appId}/aso/keywords/swap-history`,
      window.location.origin,
    );
    url.searchParams.set("limit", "200");
    if (territoryFilter) url.searchParams.set("territory", territoryFilter);
    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) {
      setError(`HTTP ${res.status.toString()}`);
      return;
    }
    const data = (await res.json()) as { swaps: SwapRow[] };
    setRows(data.swaps);
  }, [appId, territoryFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Distinct territories present in the result — drives the filter
  // chip row. We compute against UNFILTERED data… but since we only
  // have the filtered view, this is a best-effort cap. Good enough
  // since the filter is mostly used to drill down.
  const distinctTerritories = useMemo(() => {
    if (!rows) return [];
    return Array.from(new Set(rows.map((r) => r.territory))).sort();
  }, [rows]);

  return (
    <section className="space-y-3">
      <header className="flex items-baseline gap-3">
        <h2 className="font-display text-xl">Swap history</h2>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
          {rows == null
            ? "loading…"
            : `${rows.length.toString()} swap${rows.length === 1 ? "" : "s"}`}
        </span>
      </header>

      {/* Territory filter row */}
      {distinctTerritories.length > 1 || territoryFilter ? (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip active={territoryFilter === null} onClick={() => setTerritoryFilter(null)}>
            All territories
          </FilterChip>
          {distinctTerritories.map((t) => (
            <FilterChip
              key={t}
              active={territoryFilter === t}
              onClick={() =>
                setTerritoryFilter(territoryFilter === t ? null : t)
              }
            >
              <span aria-hidden>{territoryFlag(t)}</span> {territoryName(t)}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-[var(--radius-xs)] border border-[var(--status-danger)] px-3 py-2 text-[12px]">
          <span className="tone-negative font-medium">Failed to load:</span>{" "}
          <span className="text-[var(--ink-secondary)]">{error}</span>
        </div>
      ) : rows == null ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-12 rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] animate-pulse"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-[var(--radius-xs)] border border-dashed border-[var(--stroke-default)] px-4 py-6 text-center text-[12px] text-[var(--ink-tertiary)]">
          No swaps yet. Adopt a suggestion from the keyword field card to start
          building swap history.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--stroke-soft)] rounded-[var(--radius-sm)] border border-[var(--stroke-default)]">
          {rows.map((s) => (
            <SwapRowItem key={s.id} swap={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SwapRowItem({ swap }: { swap: SwapRow }): JSX.Element {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-[12px]">
      {/* Date column — compact + monospace */}
      <div className="flex min-w-[72px] flex-col font-mono text-[10px]">
        <span className="text-[var(--ink-secondary)]">
          {new Date(swap.date).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        <span className="text-[var(--ink-tertiary)]">
          {new Date(swap.date).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      {/* Old → new chip pair */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span aria-hidden>{territoryFlag(swap.territory)}</span>
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            {territoryName(swap.territory)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {swap.oldKeyword ? (
            <span className="font-semibold text-[var(--ink-tertiary)] line-through">
              {swap.oldKeyword.keyword}
            </span>
          ) : (
            <span className="italic text-[var(--ink-tertiary)]">(no predecessor)</span>
          )}
          <span aria-hidden className="text-[var(--ink-tertiary)]">→</span>
          <span className="font-semibold tone-positive">{swap.newKeyword.keyword}</span>
        </div>
        {swap.notes ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] italic text-[var(--ink-secondary)]">
            {swap.notes}
          </p>
        ) : null}
      </div>

      {/* Then → now rank chip */}
      <div className="flex flex-col items-end gap-0.5">
        {swap.oldKeyword?.rank != null || swap.newKeyword.rank != null ? (
          <RankChange
            rankYesterday={swap.oldKeyword?.rank ?? null}
            rankToday={swap.newKeyword.rank}
            delta={
              swap.oldKeyword?.rank != null && swap.newKeyword.rank != null
                ? swap.oldKeyword.rank - swap.newKeyword.rank
                : null
            }
            direction={
              swap.newKeyword.rank == null
                ? "exited"
                : swap.oldKeyword?.rank == null
                  ? "entered"
                  : swap.newKeyword.rank < swap.oldKeyword.rank
                    ? "up"
                    : "down"
            }
          />
        ) : (
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            no rank data yet
          </span>
        )}
      </div>
    </li>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
        active
          ? "pill-info"
          : "border border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
      )}
    >
      {children}
    </button>
  );
}
