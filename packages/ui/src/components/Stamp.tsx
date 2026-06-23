import * as React from "react";
import { cn } from "../lib/cn";

type StampVariant = "default" | "success" | "warning" | "danger" | "info";

/**
 * Stamp — compact status pill.
 *
 * Modern refresh: fully-rounded pill (no more ink-stamp rotation), tinted
 * background instead of just an outlined border, sentence-case content
 * instead of forced uppercase. Used for things like "Primary",
 * "Unsaved", "Watch", "Critical". The variant maps the colour family.
 */
const TINT: Record<StampVariant, string> = {
  default: "var(--surface-sunken)",
  success: "var(--status-success-tint)",
  warning: "var(--status-warning-tint)",
  danger: "var(--status-danger-tint)",
  info: "var(--status-info-tint)",
};

const FG: Record<StampVariant, string> = {
  default: "var(--ink-secondary)",
  success: "var(--status-success)",
  warning: "var(--status-warning)",
  danger: "var(--status-danger)",
  info: "var(--status-info)",
};

export interface StampProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StampVariant;
}

export function Stamp({
  variant = "default",
  className,
  style,
  ...rest
}: StampProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex select-none items-center rounded-[var(--radius-pill)] px-2 py-0.5",
        "font-body text-[11px] font-medium leading-none tracking-normal",
        className,
      )}
      style={{
        color: FG[variant],
        background: TINT[variant],
        ...style,
      }}
      {...rest}
    />
  );
}
