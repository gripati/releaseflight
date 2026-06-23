"use client";

/**
 * Dense territory grid — each territory becomes a cell in a responsive
 * 2/4/8-column layout. Each cell shows up to 10 keyword rows with
 * compact rank chips; overflow opens a centred modal popover with the
 * full list for that territory.
 *
 * Used by MoversPanel on the per-app daily check (the legacy cross-
 * app portfolio view was retired in favour of Pulse-per-app). Pure
 * presentational — caller supplies tenantSlug + appId for deep-links.
 */
import { useState } from "react";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import { cn } from "@marquee/ui";
import { RankChange, type RankDirection } from "./RankChange";
import { KeywordDetailModal } from "./KeywordDetailModal";
import { tagDotColor } from "./KeywordTagBadge";

/** Pick the highest-priority tag for a colored dot. Order:
 *  adopted > competitor > own > default > anything else. */
function dominantTag(tags: string[]): string | undefined {
  const lc = tags.map((t) => t.toLowerCase());
  const priority = ["adopted", "competitor", "own", "default"];
  for (const p of priority) if (lc.includes(p)) return p;
  return lc[0];
}

export interface TerritoryMover {
  trackedKeywordId: string;
  keyword: string;
  territory: string;
  tags: string[];
  rankYesterday: number | null;
  rankToday: number | null;
  delta: number | null;
  direction: RankDirection;
}

export interface TerritoryBucket {
  territory: string;
  climbers: TerritoryMover[];
  decliners: TerritoryMover[];
}

interface TerritoryGridProps {
  buckets: TerritoryBucket[];
  tenantSlug: string;
  appId: string;
  /** Date-range token from the page filter; forwarded to the keyword
   *  detail modal so its chart + stats reflect the same window. */
  range?: "1d" | "7d" | "14d" | "30d" | "90d";
  /** Max rows visible per cell before the "+N more" button. */
  rowsPerCell?: number;
}

const DEFAULT_ROWS_PER_CELL = 10;

/** Lifted modal state — only one keyword detail at a time, and only
 *  one territory popover. Both surfaces (cells + popover) call into
 *  the same `openKeyword` setter so clicks in the overflow popover
 *  also open the modal cleanly. */
interface KeywordModalState {
  trackedKeywordId: string;
  keyword: string;
  territory: string;
}

export function TerritoryGrid({
  buckets,
  tenantSlug,
  appId,
  range = "1d",
  rowsPerCell = DEFAULT_ROWS_PER_CELL,
}: TerritoryGridProps): JSX.Element {
  const [openTerritory, setOpenTerritory] = useState<string | null>(null);
  const [openKeyword, setOpenKeyword] = useState<KeywordModalState | null>(null);
  const opened = buckets.find((b) => b.territory === openTerritory) ?? null;

  if (buckets.length === 0) {
    return (
      <p className="text-[11px] text-[var(--ink-tertiary)]">
        No rank changes on tracked keywords today.
      </p>
    );
  }

  const onKeywordClick = (m: TerritoryMover): void => {
    setOpenKeyword({
      trackedKeywordId: m.trackedKeywordId,
      keyword: m.keyword,
      territory: m.territory,
    });
  };

  return (
    <>
      {/* Responsive territory grid. Caps at 5 columns on wide screens
          so long-tail keywords stay fully readable without truncation
          (8-col was too tight for terms like "offline puzzle game"). */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {buckets.map((b) => (
          <TerritoryCell
            key={b.territory}
            bucket={b}
            rowsPerCell={rowsPerCell}
            onKeywordClick={onKeywordClick}
            onExpand={() => setOpenTerritory(b.territory)}
          />
        ))}
      </div>

      {opened ? (
        <TerritoryPopover
          bucket={opened}
          onClose={() => setOpenTerritory(null)}
          onKeywordClick={(m) => {
            // Close the territory popover first so only one modal stacks
            // above the backdrop at a time.
            setOpenTerritory(null);
            onKeywordClick(m);
          }}
        />
      ) : null}

      {openKeyword ? (
        <KeywordDetailModal
          tenantSlug={tenantSlug}
          appId={appId}
          trackedKeywordId={openKeyword.trackedKeywordId}
          initialKeyword={openKeyword.keyword}
          initialTerritory={openKeyword.territory}
          range={range}
          onClose={() => setOpenKeyword(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Single cell — compact, fits in the 8-col grid.
// ─────────────────────────────────────────────────────────────────────

function TerritoryCell({
  bucket,
  rowsPerCell,
  onKeywordClick,
  onExpand,
}: {
  bucket: TerritoryBucket;
  rowsPerCell: number;
  onKeywordClick: (m: TerritoryMover) => void;
  onExpand: () => void;
}): JSX.Element {
  const all = [...bucket.climbers, ...bucket.decliners];
  const visible = all.slice(0, rowsPerCell);
  const overflow = all.length - visible.length;

  return (
    <div className="rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] bg-[var(--surface-paper)] px-2 py-1.5">
      <header className="mb-1 flex items-baseline gap-1 border-b border-[var(--stroke-soft)] pb-0.5">
        <span className="text-[10px] leading-none" aria-hidden>
          {territoryFlag(bucket.territory)}
        </span>
        <span
          className="truncate text-[10px] font-medium leading-none"
          title={territoryName(bucket.territory)}
        >
          {territoryName(bucket.territory)}
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-[8.5px] leading-none text-[var(--ink-tertiary)]">
          <span className="tone-positive">↑{bucket.climbers.length}</span>
          <span className="ml-0.5 tone-negative">↓{bucket.decliners.length}</span>
        </span>
      </header>
      <ul className="space-y-0">
        {visible.map((m) => (
          <CellRow
            key={m.trackedKeywordId}
            row={m}
            onClick={() => onKeywordClick(m)}
          />
        ))}
      </ul>
      {overflow > 0 ? (
        <button
          type="button"
          onClick={onExpand}
          className="mt-1 w-full text-left text-[9px] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
        >
          +{overflow.toString()} more →
        </button>
      ) : null}
    </div>
  );
}

function CellRow({
  row,
  onClick,
}: {
  row: TerritoryMover;
  onClick: () => void;
}): JSX.Element {
  // Lineage / tag dot: a single 6px circle next to the keyword name
  // hints at whether this row is a "default" metadata keyword, an
  // "adopted" swap, or competitor-borrowed — without taking the space
  // a full chip needs in the dense grid.
  const dominantTagLc = dominantTag(row.tags);
  const dotColor = dominantTagLc ? tagDotColor(dominantTagLc) : null;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-baseline gap-1.5 py-px leading-tight">
      {dotColor ? (
        <span
          aria-hidden
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: dotColor }}
          title={dominantTagLc}
        />
      ) : (
        <span aria-hidden className="h-1.5 w-1.5 flex-none" />
      )}
      {/* Bold keyword + click opens the detail modal (no route change). */}
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 truncate text-left text-[11px] font-semibold hover:underline focus:outline-none focus-visible:underline"
        title={row.keyword}
      >
        {row.keyword}
      </button>
      <RankChange
        rankYesterday={row.rankYesterday}
        rankToday={row.rankToday}
        delta={row.delta}
        direction={row.direction}
      />
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Modal popover — shown when "+N more" is clicked. Full keyword list.
// ─────────────────────────────────────────────────────────────────────

function TerritoryPopover({
  bucket,
  onClose,
  onKeywordClick,
}: {
  bucket: TerritoryBucket;
  onClose: () => void;
  onKeywordClick: (m: TerritoryMover) => void;
}): JSX.Element {
  const all = [...bucket.climbers, ...bucket.decliners];

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
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(560px,92vw)]",
          "-translate-x-1/2 -translate-y-1/2",
          "flex flex-col rounded-[var(--radius-sm)] border border-[var(--stroke-default)]",
          "bg-[var(--surface-paper)] shadow-2xl",
        )}
      >
        <header className="flex items-baseline gap-2 border-b border-[var(--stroke-default)] px-4 py-3">
          <span className="text-[14px]" aria-hidden>
            {territoryFlag(bucket.territory)}
          </span>
          <h3 className="font-display text-base">{territoryName(bucket.territory)}</h3>
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            <span className="tone-positive">↑{bucket.climbers.length}</span>
            <span className="ml-1.5 tone-negative">↓{bucket.decliners.length}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[11px] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
          >
            Close
          </button>
        </header>
        <ul className="flex-1 overflow-y-auto divide-y divide-[var(--stroke-soft)]">
          {all.map((m) => (
            <PopoverRow
              key={m.trackedKeywordId}
              row={m}
              onClick={() => onKeywordClick(m)}
            />
          ))}
        </ul>
      </div>
    </>
  );
}

function PopoverRow({
  row,
  onClick,
}: {
  row: TerritoryMover;
  onClick: () => void;
}): JSX.Element {
  const dominantTagLc = dominantTag(row.tags);
  const dotColor = dominantTagLc ? tagDotColor(dominantTagLc) : null;
  return (
    <li className="px-4 py-2 text-[12px]">
      <button
        type="button"
        onClick={onClick}
        className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-2 text-left hover:underline focus:outline-none focus-visible:underline"
      >
        {dotColor ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: dotColor }}
            title={dominantTagLc}
          />
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 flex-none" />
        )}
        <span className="min-w-0 truncate">
          <span className="font-semibold">{row.keyword}</span>
          {row.tags.length > 0 ? (
            <span className="ml-1.5 font-mono text-[9px] text-[var(--ink-tertiary)]">
              {row.tags.join(",")}
            </span>
          ) : null}
        </span>
        <RankChange
          rankYesterday={row.rankYesterday}
          rankToday={row.rankToday}
          delta={row.delta}
          direction={row.direction}
        />
      </button>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helper: turn a flat climbers+decliners pair into territory buckets.
// Both panels (portfolio + per-app) call this in their own data prep
// stage, so the grouping logic lives in one place.
// ─────────────────────────────────────────────────────────────────────

export function bucketByTerritory(
  climbers: TerritoryMover[],
  decliners: TerritoryMover[],
): TerritoryBucket[] {
  const idx = new Map<string, { climbers: TerritoryMover[]; decliners: TerritoryMover[] }>();
  for (const m of climbers) {
    const slot = idx.get(m.territory) ?? { climbers: [], decliners: [] };
    slot.climbers.push(m);
    idx.set(m.territory, slot);
  }
  for (const m of decliners) {
    const slot = idx.get(m.territory) ?? { climbers: [], decliners: [] };
    slot.decliners.push(m);
    idx.set(m.territory, slot);
  }
  return Array.from(idx.entries())
    .map(([territory, lists]) => ({ territory, ...lists }))
    .sort((a, b) => {
      const totalA = a.climbers.length + a.decliners.length;
      const totalB = b.climbers.length + b.decliners.length;
      if (totalB !== totalA) return totalB - totalA;
      return a.territory.localeCompare(b.territory);
    });
}
