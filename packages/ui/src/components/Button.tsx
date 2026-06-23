import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 font-body font-medium select-none whitespace-nowrap",
    "transition-all duration-[160ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "focus-visible:ring-offset-[var(--surface-paper)]",
    "disabled:opacity-40 disabled:pointer-events-none",
    "active:scale-[0.97]",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: cn(
          "bg-[var(--signal)] text-[var(--signal-on)] hover:bg-[var(--signal-hover)]",
          "shadow-[var(--shadow-soft)] focus-visible:ring-[var(--signal)]",
        ),
        secondary: cn(
          "bg-[var(--surface-elevated)] text-[var(--ink-primary)]",
          "shadow-[var(--shadow-hairline)] hover:bg-[var(--surface-tinted)]",
          "focus-visible:ring-[var(--ink-primary)]",
        ),
        ghost: cn(
          "bg-transparent text-[var(--ink-primary)] hover:bg-[var(--surface-tinted)]",
          "focus-visible:ring-[var(--ink-primary)]",
        ),
        destructive: cn(
          "bg-[var(--status-danger)] text-white hover:opacity-90",
          "focus-visible:ring-[var(--status-danger)]",
        ),
        link: cn(
          "bg-transparent text-[var(--ink-primary)] underline-offset-4 hover:underline",
          "px-0 h-auto focus-visible:ring-[var(--ink-primary)]",
        ),
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-[var(--radius-sm)]",
        md: "h-9 px-4 text-[13px] rounded-[var(--radius-sm)] tracking-[-0.01em]",
        lg: "h-11 px-6 text-[14px] rounded-[var(--radius)] tracking-[-0.01em]",
        icon: "h-9 w-9 rounded-[var(--radius-sm)]",
      },
      editorial: {
        true: "hover:-translate-y-[1px]",
        false: "",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", editorial: true },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, editorial, type = "button", asChild: _asChild, ...rest }, ref) => (
    <button
      type={type}
      ref={ref}
      className={cn(buttonVariants({ variant, size, editorial }), className)}
      {...rest}
    />
  ),
);
Button.displayName = "Button";
