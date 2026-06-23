import * as React from "react";
import { cn } from "../lib/cn";

export interface CharLimitBarProps {
  value: number;
  max: number;
  className?: string;
}

export function CharLimitBar({ value, max, className }: CharLimitBarProps): JSX.Element {
  const pct = Math.min(100, max === 0 ? 0 : (value / max) * 100);
  const color =
    value > max
      ? "var(--status-danger)"
      : pct > 90
        ? "var(--status-warning)"
        : pct > 70
          ? "var(--ink-secondary)"
          : "var(--ink-quaternary)";

  return (
    <div className={cn("mt-1 flex items-center gap-3", className)} aria-hidden>
      <div className="relative h-px flex-1 bg-[var(--stroke-default)]">
        <div
          className="absolute inset-y-0 left-0 transition-[width,background-color]"
          style={{
            width: `${pct.toString()}%`,
            background: color,
            transitionDuration: "240ms",
            transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums" style={{ color }}>
        {value}/{max}
      </span>
    </div>
  );
}
