"use client";

/**
 * LocaleStrip — horizontal locale picker used across every per-app
 * surface that scopes by language (Metadata, Keywords, Screenshots,
 * App Previews, Competitor Compare).
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  [All]  [🇺🇸 US]  [🇫🇷 FR]  [🇩🇪 DE]  [🇪🇸 ES]  [🇮🇹 IT]  …→     │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Replaces the legacy 240 px vertical `LocaleRail` because:
 *   • Frees the entire canvas width — Metadata + Screenshots layouts
 *     get ~240 px more horizontal room for chips, screenshots, etc.
 *   • Faster visual scan — flags-in-a-row reads naturally left→right
 *     instead of a long vertical list that demands scrolling for the
 *     20th locale.
 *   • Naturally filters to "only the locales this app actually ships
 *     in" — the strip stays compact, no search needed for <20 locales
 *     and a horizontal scrollbar covers the long-tail.
 *
 * Each chip: flag · uppercase ISO country code (territory). Hover
 * tooltip carries the native language name + full locale code so
 * power users can disambiguate (en-US vs en-GB).
 *
 * Selected chip gets a filled-ink pill (high contrast), default is
 * ghost with hover-tinted bg. Optional state dot + numeric badge slot
 * to the right of the code. Primary locale floats to the far left
 * and carries a subtle "Primary" hint on hover.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { StateDot, type StateDotState, cn } from "@marquee/ui";
import { localeMeta } from "@/lib/localeMeta";
import { localeRegion } from "@marquee/core/locale";

export interface LocaleStripEntry {
  locale: string;
  /** State dot — flags Pending Push, errors, syncing, etc. */
  state?: StateDotState;
  /** Optional numeric badge (e.g. unread opportunities). */
  badge?: number;
}

export interface LocaleStripProps {
  entries: LocaleStripEntry[];
  /** Currently-selected locale, or null for "All". */
  selected: string | null;
  onSelect: (locale: string | null) => void;
  /** Show the "All" pseudo-chip at the left. Keywords uses it; the
   *  other surfaces leave it off because they always need one locale
   *  in scope. */
  allowAll?: boolean;
  /** App's primary locale — floats to the far left + carries a hint. */
  primaryLocale?: string;
  /** Expand a search input alongside the chips. Default false. */
  showSearch?: boolean;
  /** Custom label for the "All" chip. */
  allLabel?: string;
  /** Render at zero margin (consumer controls placement). */
  className?: string;
}

export function LocaleStrip({
  entries,
  selected,
  onSelect,
  allowAll = false,
  primaryLocale,
  showSearch = false,
  allLabel = "All",
  className,
}: LocaleStripProps): JSX.Element {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries
      .filter((e) => {
        if (q.length === 0) return true;
        if (e.locale.toLowerCase().includes(q)) return true;
        const meta = localeMeta(e.locale);
        if (meta.name.toLowerCase().includes(q)) return true;
        return localeRegion(e.locale).toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Primary locale always first; everything else alphabetical
        // by territory code (closer to what the user reads off the
        // chip than the language code).
        if (primaryLocale) {
          if (a.locale === primaryLocale) return -1;
          if (b.locale === primaryLocale) return 1;
        }
        const ra = localeRegion(a.locale);
        const rb = localeRegion(b.locale);
        return ra.localeCompare(rb);
      });
  }, [entries, filter, primaryLocale]);

  const totalBadge = useMemo(
    () => entries.reduce((s, e) => s + (e.badge ?? 0), 0),
    [entries],
  );

  return (
    <nav
      aria-label="Locale picker"
      className={cn(
        "scroll-fine flex items-center gap-1.5 overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-1.5",
        className,
      )}
    >
      {allowAll && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-pressed={selected === null}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-3 py-1.5 text-[12px] font-semibold leading-none transition-colors",
            selected === null
              ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
          )}
        >
          {allLabel}
          {totalBadge > 0 && selected !== null && (
            <span className="rounded-[var(--radius-pill)] bg-[var(--signal-tint)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--signal)]">
              {totalBadge > 99 ? "99+" : totalBadge.toString()}
            </span>
          )}
        </button>
      )}

      {filtered.length === 0 ? (
        <p className="px-3 py-1.5 text-[12px] text-[var(--ink-tertiary)]">
          No locales match.
        </p>
      ) : (
        filtered.map((e) => (
          <LocaleChipInline
            key={e.locale}
            entry={e}
            selected={selected === e.locale}
            isPrimary={primaryLocale != null && e.locale === primaryLocale}
            onSelect={() => onSelect(e.locale)}
          />
        ))
      )}

      {showSearch && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-paper)] px-2 py-1 focus-within:border-[var(--ink-primary)]">
          <Search size={11} className="text-[var(--ink-tertiary)]" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter"
            className="w-[80px] bg-transparent text-[11px] outline-none placeholder:text-[var(--ink-tertiary)]"
          />
        </div>
      )}
    </nav>
  );
}

interface ChipProps {
  entry: LocaleStripEntry;
  selected: boolean;
  isPrimary: boolean;
  onSelect: () => void;
}

function LocaleChipInline({
  entry,
  selected,
  isPrimary,
  onSelect,
}: ChipProps): JSX.Element {
  const meta = localeMeta(entry.locale);
  const region = localeRegion(entry.locale).toUpperCase();
  // Compose a rich tooltip — native language name + ISO locale code +
  // primary hint. Helps the operator disambiguate same-region locales
  // (e.g. fr-CA vs en-CA both render as 🇨🇦 CA without text disambig).
  const tooltip = [
    meta.name,
    entry.locale,
    isPrimary ? "Primary locale" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasState =
    entry.state != null && entry.state !== "synced" && entry.state !== "empty";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={tooltip}
      lang={entry.locale}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[12px] font-medium leading-none transition-colors",
        selected
          ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
          : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
        // Primary chip gets a subtle accent on the left edge when it's
        // not the active selection — keeps it visually findable.
        isPrimary &&
          !selected &&
          "ring-1 ring-inset ring-[var(--signal)]/30",
      )}
    >
      <span aria-hidden className="text-[14px] leading-none">
        {meta.flag}
      </span>
      <span className="font-mono tabular-nums">{region}</span>
      {hasState && entry.state != null && (
        <StateDot state={entry.state} pulse={entry.state === "syncing"} />
      )}
      {entry.badge !== undefined && entry.badge !== null && entry.badge > 0 && (
        <span
          className={cn(
            "rounded-[var(--radius-pill)] px-1 text-[10px] font-semibold tabular-nums",
            selected
              ? "bg-[var(--surface-paper)]/20 text-[var(--surface-paper)]"
              : "bg-[var(--signal-tint)] text-[var(--signal)]",
          )}
        >
          {entry.badge > 99 ? "99+" : entry.badge.toString()}
        </span>
      )}
    </button>
  );
}
