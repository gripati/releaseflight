import * as React from "react";
import { cn } from "../lib/cn";

export interface SectionBreakProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function SectionBreak({ label, className, ...rest }: SectionBreakProps): JSX.Element {
  return (
    <div
      className={cn(
        "my-12 flex items-center gap-4 font-body text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]",
        className,
      )}
      {...rest}
    >
      <span className="flex-1 border-t-[0.5px] border-[var(--stroke-default)]" />
      {label ? <span>{label}</span> : null}
      <span className="flex-1 border-t-[0.5px] border-[var(--stroke-default)]" />
    </div>
  );
}
