/**
 * Single source of truth for rendering keyword tag pills across the
 * keyword list, movers grid, daily-check panel and detail modal. The
 * reserved tags map to semantic tones (chip-*) defined in globals.css
 * so light/dark theme work without per-component variants.
 *
 *   default    → neutral gray   (ground-truth metadata keyword)
 *   adopted    → positive       (experimental swap from suggestion)
 *   competitor → warning         (mined from a rival's metadata)
 *   own        → info (signal)   (manually flagged "core" keyword)
 *   watch      → neutral border  (informational track only)
 *   seasonal   → warning         (timing-bound)
 *   brand      → info            (brand / trademark)
 *   painkiller → positive        (high-intent problem solver)
 *
 * Arbitrary user tags fall back to neutral.
 */
import { cn } from "@marquee/ui";

interface KeywordTagBadgeProps {
  tag: string;
  /** Drop the "·" prefix between tags when rendered in a list. */
  showDot?: boolean;
}

export function KeywordTagBadge({ tag, showDot }: KeywordTagBadgeProps): JSX.Element {
  const lc = tag.toLowerCase();
  const cls =
    lc === "default"
      ? "chip-neutral"
      : lc === "adopted"
        ? "chip-positive"
        : lc === "competitor"
          ? "chip-warning"
          : lc === "own"
            ? "chip-info"
            : lc === "watch"
              ? "chip-neutral"
              : lc === "seasonal"
                ? "chip-warning"
                : lc === "brand"
                  ? "chip-info"
                  : lc === "painkiller"
                    ? "chip-positive"
                    : "chip-neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.04em]",
        cls,
      )}
      title={tag}
    >
      {showDot ? (
        <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-60" />
      ) : null}
      {lc}
    </span>
  );
}

/** Render an entire row of tag badges. Filters duplicates + lowers
 *  case for display consistency. */
export function KeywordTagRow({
  tags,
  max,
}: {
  tags: string[];
  /** Cap how many badges to render — extras become "+N". */
  max?: number;
}): JSX.Element {
  const unique = Array.from(new Set(tags.map((t) => t.toLowerCase())));
  const visible = max ? unique.slice(0, max) : unique;
  const overflow = max ? Math.max(0, unique.length - max) : 0;
  if (unique.length === 0) return <></>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <KeywordTagBadge key={t} tag={t} />
      ))}
      {overflow > 0 ? (
        <span className="font-mono text-[9px] text-[var(--ink-tertiary)]">
          +{overflow.toString()}
        </span>
      ) : null}
    </span>
  );
}

/** Map a tag to its semantic dot color — used by the TerritoryGrid
 *  cells where we want a single colored dot, not a full chip. Returns
 *  a CSS variable name. */
export function tagDotColor(tag: string | undefined): string {
  const lc = (tag ?? "").toLowerCase();
  if (lc === "adopted" || lc === "painkiller") return "var(--status-success)";
  if (lc === "competitor" || lc === "seasonal") return "var(--status-warning)";
  if (lc === "own" || lc === "brand") return "var(--signal)";
  return "var(--ink-tertiary)";
}
