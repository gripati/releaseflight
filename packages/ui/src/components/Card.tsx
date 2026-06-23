import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Card — the standard surface for grouped content.
 *
 * Modern refresh: 12 px radius (matches `--radius-lg`), real soft
 * elevation shadow (multi-layer y-offset blur + 1 px stroke), and
 * 20 px inner padding so the contents have breathing room. Callers
 * that need different padding can override via className.
 */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-5",
        className,
      )}
      {...rest}
    />
  ),
);
Card.displayName = "Card";
