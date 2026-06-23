import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Editorial spinner — three pulsing dots rather than a default svg ring.
 */
export function Spinner({ size = 14, className }: { size?: number; className?: string }): JSX.Element {
  const dot = "rounded-full bg-current motion-safe:animate-[pulse_1.2s_ease-in-out_infinite]";
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-flex items-center gap-1 text-current", className)}
      style={{ height: size }}
    >
      <span className={dot} style={{ width: size * 0.3, height: size * 0.3, animationDelay: "0ms" }} />
      <span className={dot} style={{ width: size * 0.3, height: size * 0.3, animationDelay: "150ms" }} />
      <span className={dot} style={{ width: size * 0.3, height: size * 0.3, animationDelay: "300ms" }} />
    </span>
  );
}
