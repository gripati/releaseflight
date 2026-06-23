/**
 * Compact "was → now" rank chip — one line, monospace, theme-aware.
 *
 * Variants:
 *   • numeric move  →  `#5 → #12 −7`   (delta as a coloured number,
 *                                       no redundant chip)
 *   • exited list   →  `#5 → off`      (whole right side coloured)
 *   • entered list  →  `new → #6`      (whole right side coloured)
 *
 * Pure presentational; colours flow through the design-system
 * `--status-*` tokens so dark/light mode swap automatically.
 */
import { cn } from "@marquee/ui";

export type RankDirection = "up" | "down" | "entered" | "exited";

interface RankChangeProps {
  rankYesterday: number | null;
  rankToday: number | null;
  delta: number | null;
  direction: RankDirection;
}

export function RankChange({
  rankYesterday,
  rankToday,
  delta,
  direction,
}: RankChangeProps): JSX.Element {
  const positive = direction === "up" || direction === "entered";
  const toneClass = positive ? "tone-positive" : "tone-negative";

  if (direction === "entered") {
    return (
      <span className="inline-flex items-baseline gap-1 font-mono text-[11px] tabular-nums">
        <span className="text-[var(--ink-tertiary)]">new</span>
        <Arrow />
        <span className={cn("font-semibold", toneClass)}>#{(rankToday ?? 0).toString()}</span>
      </span>
    );
  }

  if (direction === "exited") {
    return (
      <span className="inline-flex items-baseline gap-1 font-mono text-[11px] tabular-nums">
        {/* Old rank: muted gray so it reads as "history". */}
        <span className="text-[var(--ink-tertiary)]">#{(rankYesterday ?? 0).toString()}</span>
        <Arrow />
        {/* Today: red because we just fell off the list. */}
        <span className={cn("font-semibold", toneClass)}>off</span>
      </span>
    );
  }

  const deltaLabel = delta != null && delta !== 0 ? (delta > 0 ? `+${delta}` : `${delta}`) : "";
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-[11px] tabular-nums">
      {/* Old rank: muted gray — clearly the "before" side. */}
      <span className="text-[var(--ink-tertiary)]">#{(rankYesterday ?? 0).toString()}</span>
      <Arrow />
      {/* New rank: green if improved (lower number), red if dropped. */}
      <span className={cn("font-semibold", toneClass)}>#{(rankToday ?? 0).toString()}</span>
      {deltaLabel ? (
        <span className={cn("text-[10px]", toneClass)} aria-label={`delta ${deltaLabel}`}>
          {deltaLabel}
        </span>
      ) : null}
    </span>
  );
}

function Arrow(): JSX.Element {
  return (
    <span aria-hidden className="text-[var(--ink-tertiary)]">
      →
    </span>
  );
}
