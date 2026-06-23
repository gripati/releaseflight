import * as React from "react";
import { localeName, localeFlag } from "@marquee/core/locale";
import { cn } from "../lib/cn";
import { StateDot, type StateDotState } from "./StateDot";

export interface LocaleChipProps {
  locale: string;
  charCount?: number;
  charLimit?: number;
  state: StateDotState;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

/**
 * Per-locale picker chip used by the Metadata editor's locale rail.
 * Layout: flag · language name + locale code · char counter · state dot.
 * The flag leads for fast scanning; the language name (native script)
 * keeps the editorial feel.
 */
export function LocaleChip({
  locale,
  charCount,
  charLimit,
  state,
  selected = false,
  onSelect,
  className,
}: LocaleChipProps): JSX.Element {
  const name = localeName(locale);
  const flag = localeFlag(locale);

  // Title-length signal — only render when the locale's title is at
  // 80% of the limit or already over. Below that the counter is just
  // noise across 39 locale chips, so we hide it entirely. The number
  // alone reads as a counter; hover tooltip clarifies which field.
  const showCounter =
    typeof charCount === "number" &&
    typeof charLimit === "number" &&
    charLimit > 0 &&
    charCount / charLimit >= 0.8;
  const charLabel = showCounter ? (
    <span
      title={`Title: ${charCount}/${charLimit} characters`}
      className={cn(
        "inline-flex items-center rounded-[var(--radius-pill)] px-1.5 py-px",
        "font-mono text-[10px] font-semibold tabular-nums",
        charCount > charLimit
          ? "bg-[var(--status-danger-tint)] text-[var(--status-danger)]"
          : "bg-[var(--status-warning-tint)] text-[var(--status-warning)]",
      )}
    >
      {charCount}/{charLimit}
    </span>
  ) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      lang={locale}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-left",
        "transition-colors duration-[140ms]",
        selected
          ? "bg-[var(--signal-tint)]"
          : "hover:bg-[var(--surface-tinted)]",
        className,
      )}
    >
      <span aria-hidden className="shrink-0 text-[16px] leading-none">
        {flag}
      </span>

      {/* Only the native language name renders here. The locale code
       *  (e.g. "en-US") used to sit underneath in mono type, but with
       *  the flag already carrying region identity it was redundant
       *  noise across 39 chips. The code is still searchable via the
       *  rail's filter input. */}
      <span
        className={cn(
          "block min-w-0 flex-1 truncate font-body text-[12px] leading-tight",
          selected
            ? "font-semibold text-[var(--ink-primary)]"
            : "text-[var(--ink-primary)]",
        )}
      >
        {name}
      </span>

      {charLabel}
      {/* State dot is only meaningful when something is non-trivial —
       *  showing a grey "synced" dot on every locale just adds visual
       *  noise. Hide it when the locale is in steady state. */}
      {state !== "synced" && state !== "empty" && (
        <StateDot state={state} pulse={state === "syncing"} />
      )}
    </button>
  );
}
