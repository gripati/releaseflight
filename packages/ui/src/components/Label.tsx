import * as React from "react";
import { cn } from "../lib/cn";

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...rest }, ref) => (
    <label
      ref={ref}
      className={cn(
        "block font-body text-[13px] font-medium text-[var(--ink-primary)] tracking-[-0.01em]",
        className,
      )}
      {...rest}
    />
  ),
);
Label.displayName = "Label";
