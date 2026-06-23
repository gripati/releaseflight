import * as React from "react";
import { cn } from "../lib/cn";

export type StateDotState = "synced" | "dirty" | "syncing" | "error" | "empty";

const STATE_COLOR: Record<StateDotState, string> = {
  synced: "var(--state-synced)",
  dirty: "var(--state-dirty)",
  syncing: "var(--state-syncing)",
  error: "var(--state-error)",
  empty: "var(--ink-quaternary)",
};

export interface StateDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StateDotState;
  pulse?: boolean;
  size?: number;
  /** Accessible label; defaults to the state name. */
  label?: string;
}

export function StateDot({
  state,
  pulse = false,
  size = 8,
  label,
  className,
  ...rest
}: StateDotProps): JSX.Element {
  const color = STATE_COLOR[state];
  return (
    <span
      role="status"
      aria-label={label ?? state}
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      {...rest}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      {pulse && state === "syncing" ? (
        <span
          className="absolute inset-0 rounded-full motion-safe:animate-ping"
          style={{ background: color, opacity: 0.45 }}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
