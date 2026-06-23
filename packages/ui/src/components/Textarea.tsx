import * as React from "react";
import { cn } from "../lib/cn";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Multi-line text input that mirrors `Input`'s contrast + focus treatment.
 * Use this everywhere instead of bare `<textarea>` so the design system
 * stays uniform across the app.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // box — pillowy radius + generous padding so content stays
        // away from the rounded border instead of hugging the edges.
        "min-h-[88px] w-full rounded-[var(--radius)] px-4 py-3",
        "bg-[var(--surface-input)] hover:bg-[var(--surface-input-hover)]",
        // text
        "font-body text-[14px] leading-[1.55] text-[var(--ink-primary)]",
        "placeholder:text-[var(--ink-tertiary)] placeholder:font-normal",
        // border / shadow
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
        // resize
        "resize-y",
        className,
      )}
      {...rest}
    />
  ),
);
Textarea.displayName = "Textarea";
