import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Editorial-paper skeleton placeholder.
 *
 * Uses a slow shimmer (3s) rather than the loud 1.5s pulse most UI kits
 * default to — paper-themed surfaces aren't supposed to "throb". The
 * animation respects `prefers-reduced-motion`.
 */
export function Skeleton({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-xs)] bg-[var(--surface-tinted)]",
        "motion-safe:animate-[skeleton-shimmer_2.6s_ease-in-out_infinite]",
        className,
      )}
      {...rest}
    />
  );
}

/** Pre-styled rectangle for image / screenshot placeholders. */
export function SkeletonImage({
  className,
  aspect = "9 / 16",
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { aspect?: string }): JSX.Element {
  return (
    <Skeleton
      className={cn("rounded-[var(--radius-sm)]", className)}
      style={{ aspectRatio: aspect }}
      {...rest}
    />
  );
}

/** Stack of n rows, each a line of text. */
export function SkeletonLines({ count = 3, className }: { count?: number; className?: string }): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3"
          style={{ width: `${(100 - i * 8).toString()}%` }}
        />
      ))}
    </div>
  );
}
