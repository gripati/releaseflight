/**
 * "Are my swaps paying off?" widget.
 *
 * Sits on the per-app daily check panel (and could be reused in the
 * portfolio later). Shows three numbers + a verdict pill:
 *
 *   Adopted N · avg #18    Default M · avg #24    [WINNING −6]
 *
 * Pure presentational — caller computes the summary via
 * `summariseAdoptedPerformance` and passes it in. Renders compactly
 * (single row) so the daily panel doesn't bloat.
 */
import { cn } from "@marquee/ui";

export type AdoptedVerdict = "winning" | "behind" | "even" | "insufficient";

interface AdoptedPerformanceWidgetProps {
  adoptedTotal: number;
  defaultTotal: number;
  adoptedAvgRank: number | null;
  defaultAvgRank: number | null;
  rankDelta: number | null;
  verdict: AdoptedVerdict;
}

export function AdoptedPerformanceWidget({
  adoptedTotal,
  defaultTotal,
  adoptedAvgRank,
  defaultAvgRank,
  rankDelta,
  verdict,
}: AdoptedPerformanceWidgetProps): JSX.Element {
  // Don't render if there's truly nothing useful — caller would
  // otherwise show a meaningless "0 · 0" row.
  if (adoptedTotal === 0 && defaultTotal === 0) return <></>;

  const verdictTone =
    verdict === "winning"
      ? "pill-positive"
      : verdict === "behind"
        ? "pill-negative"
        : verdict === "even"
          ? "pill-neutral"
          : "pill-neutral";

  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--stroke-default)] bg-[var(--surface-paper)] p-3">
      <header className="mb-2 flex items-baseline gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
          Swap impact
        </h3>
        <span className="text-[10px] text-[var(--ink-tertiary)]">
          adopted vs default avg rank
        </span>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.04em]",
            verdictTone,
          )}
        >
          {verdict === "winning"
            ? `↑ winning${rankDelta != null ? ` ${rankDelta.toFixed(1)}` : ""}`
            : verdict === "behind"
              ? `↓ behind${rankDelta != null ? ` +${rankDelta.toFixed(1)}` : ""}`
              : verdict === "even"
                ? "even"
                : "not enough data"}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-3">
        <Side
          label="Adopted"
          count={adoptedTotal}
          avgRank={adoptedAvgRank}
          /* Highlight side when winning. */
          highlight={verdict === "winning"}
          tone="positive"
        />
        <Side
          label="Default"
          count={defaultTotal}
          avgRank={defaultAvgRank}
          highlight={verdict === "behind"}
          tone="neutral"
        />
      </div>
    </section>
  );
}

function Side({
  label,
  count,
  avgRank,
  highlight,
  tone,
}: {
  label: string;
  count: number;
  avgRank: number | null;
  highlight: boolean;
  tone: "positive" | "neutral";
}): JSX.Element {
  const accentClass = highlight && tone === "positive" ? "tone-positive" : "";
  return (
    <div
      className={cn(
        "rounded-[var(--radius-xs)] border px-2.5 py-2",
        highlight
          ? "border-[var(--stroke-default)] bg-[var(--surface-elevated)]"
          : "border-[var(--stroke-soft)]",
      )}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={cn("font-display text-lg tabular-nums", accentClass)}>
          {count.toString()}
        </span>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
          avg{" "}
          <span className={cn("text-[var(--ink-secondary)] tabular-nums", accentClass)}>
            {avgRank == null ? "—" : `#${avgRank.toFixed(1)}`}
          </span>
        </span>
      </div>
    </div>
  );
}
