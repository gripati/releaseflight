"use client";

/**
 * Per-app "today's rank movers" card. Renders movers as an 8-col grid
 * of territory cells, identical visual language as the portfolio card.
 * 10 keywords per cell; overflow opens a popover for the full list.
 */
import { useMemo } from "react";
import { cn } from "@marquee/ui";
import {
  TerritoryGrid,
  bucketByTerritory,
  type TerritoryMover,
} from "./TerritoryGrid";
import type { RankDirection } from "./RankChange";

export type MoverDirection = RankDirection;

export type MoverRow = TerritoryMover;

interface MoversPanelProps {
  climbers: MoverRow[];
  decliners: MoverRow[];
  tenantSlug: string;
  appId: string;
  totals: {
    climbers: number;
    decliners: number;
    entered: number;
    exited: number;
    unchanged: number;
  };
  embedded?: boolean;
}

export function MoversPanel({
  climbers,
  decliners,
  tenantSlug,
  appId,
  totals,
  embedded,
}: MoversPanelProps): JSX.Element {
  const totalMoved = totals.climbers + totals.decliners + totals.entered + totals.exited;

  const buckets = useMemo(
    () => bucketByTerritory(climbers, decliners),
    [climbers, decliners],
  );

  return (
    <section
      className={cn(
        embedded ? "" : "rounded-[var(--radius-sm)] border border-[var(--stroke-default)]",
        "p-3",
      )}
    >
      {!embedded ? (
        <header className="mb-2 flex items-baseline gap-2">
          <h3 className="font-display text-base">Rank movers</h3>
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            {totalMoved} moved · {totals.unchanged} unchanged
          </span>
          {totalMoved > 0 ? (
            <span className="ml-auto font-mono text-[10px]">
              <span className="tone-positive">↑{totals.climbers + totals.entered}</span>
              <span className="ml-1.5 tone-negative">↓{totals.decliners + totals.exited}</span>
            </span>
          ) : null}
        </header>
      ) : null}

      {totalMoved === 0 ? (
        <p className="text-[12px] text-[var(--ink-tertiary)]">
          No rank changes on tracked keywords today.
        </p>
      ) : (
        <TerritoryGrid buckets={buckets} tenantSlug={tenantSlug} appId={appId} />
      )}
    </section>
  );
}
