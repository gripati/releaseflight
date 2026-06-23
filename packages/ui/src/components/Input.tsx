import * as React from "react";
import { cn } from "../lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Form input with WCAG-AA contrast in both light and dark themes.
 *
 *   bg              → surface-input (visibly raised from paper)
 *   text            → ink-primary (19.6:1 light / 14:1 dark)
 *   placeholder     → ink-tertiary (5.9:1 light / 4.7:1 dark — was 4.04:1 / 3.0:1)
 *   border          → stroke-input (0.20 / 0.24 alpha — was 0.10, near-invisible)
 *   focus           → signal ring + thicker border
 *   invalid         → status-danger ring (when aria-invalid="true")
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      // box — generous horizontal padding (18 px) so text breathes
      // away from the rounded border instead of crowding the edges.
      "h-11 w-full rounded-[var(--radius)] px-4 py-2.5",
      "bg-[var(--surface-input)] hover:bg-[var(--surface-input-hover)]",
      // text
      "font-body text-[14px] leading-[1.4] text-[var(--ink-primary)]",
      "placeholder:text-[var(--ink-tertiary)] placeholder:font-normal",
      // border / shadow — visible at rest, prominent on focus
      "border-[1.5px] border-[var(--stroke-input)]",
      "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
      // motion
      "transition-[border-color,background-color,box-shadow] duration-[140ms]",
      "[transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
      // focus
      "focus:outline-none focus:border-[var(--signal)] focus:bg-[var(--surface-input-focus)]",
      "focus:ring-[3px] focus:ring-[var(--signal)]/22",
      // invalid
      "aria-[invalid=true]:border-[var(--status-danger)]",
      "aria-[invalid=true]:focus:ring-[var(--status-danger)]/22",
      // disabled
      "disabled:cursor-not-allowed disabled:bg-[var(--surface-input-disabled)]",
      "disabled:text-[var(--ink-tertiary)] disabled:placeholder:text-[var(--ink-quaternary)]",
      className,
    )}
    {...rest}
  />
));
Input.displayName = "Input";
