import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/cn";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** Optional label rendered to the right of the box. When provided,
   *  the component wraps both in a `<label>` so the whole row is
   *  clickable. */
  label?: React.ReactNode;
  /** Compact size knob — `md` is the default at 16 px; `sm` drops to
   *  14 px for use in dense filter rows. */
  size?: "sm" | "md";
}

/**
 * Modern square checkbox that matches the rest of the design system —
 * pillowy radius, solid 1.5 px border at rest, signal-color fill when
 * checked, smooth 140 ms transition. Built as a styled wrapper around
 * a hidden native `<input type="checkbox">` so it stays accessible
 * (keyboard, screen-reader, form submission) without extra ARIA.
 *
 *   ☐ Off               ☑ On (signal-color fill + white check)
 *   Hover: tinted bg    Focus: signal ring
 *
 * Pair with a label via the `label` prop (renders as `<label>`) so the
 * whole row is clickable.
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, size = "md", checked, disabled, ...rest }, ref) => {
    const dim = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
    const iconSize = size === "sm" ? 10 : 12;

    const box = (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center",
          dim,
          "rounded-[var(--radius-xs)] border-[1.5px]",
          "transition-[background-color,border-color,box-shadow] duration-[140ms]",
          checked
            ? "border-[var(--signal)] bg-[var(--signal)]"
            : "border-[var(--stroke-input)] bg-[var(--surface-input)] group-hover:border-[var(--ink-secondary)] group-hover:bg-[var(--surface-input-hover)]",
          disabled && "opacity-50",
        )}
      >
        <Check
          size={iconSize}
          strokeWidth={3}
          className={cn(
            "text-[var(--signal-on)] transition-opacity duration-[100ms]",
            checked ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
    );

    const input = (
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className={cn(
          // visually hide but keep accessible
          "peer absolute h-px w-px overflow-hidden whitespace-nowrap",
          "[clip:rect(0,0,0,0)]",
          // focus ring lands on the visible box via :has() — fallback
          // shows on the input itself for older browsers
          "focus:outline-none",
        )}
        {...rest}
      />
    );

    if (label !== undefined) {
      return (
        <label
          className={cn(
            "group inline-flex select-none items-center gap-2",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            "text-[12px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
            "[&:has(:focus-visible)>span:first-of-type]:ring-2 [&:has(:focus-visible)>span:first-of-type]:ring-[var(--signal)] [&:has(:focus-visible)>span:first-of-type]:ring-offset-2 [&:has(:focus-visible)>span:first-of-type]:ring-offset-[var(--surface-paper)]",
            className,
          )}
        >
          {box}
          {input}
          <span>{label}</span>
        </label>
      );
    }

    return (
      <span
        className={cn(
          "group relative inline-flex",
          "[&:has(:focus-visible)>span:first-of-type]:ring-2 [&:has(:focus-visible)>span:first-of-type]:ring-[var(--signal)] [&:has(:focus-visible)>span:first-of-type]:ring-offset-2 [&:has(:focus-visible)>span:first-of-type]:ring-offset-[var(--surface-paper)]",
          className,
        )}
      >
        {box}
        {input}
      </span>
    );
  },
);
Checkbox.displayName = "Checkbox";
