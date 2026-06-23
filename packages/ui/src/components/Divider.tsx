import * as React from "react";
import { cn } from "../lib/cn";

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

export function Divider({ orientation = "horizontal", className, ...rest }: DividerProps): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        orientation === "horizontal"
          ? "h-0 w-full border-t-[0.5px] border-[var(--stroke-default)]"
          : "h-full w-0 border-l-[0.5px] border-[var(--stroke-default)]",
        className,
      )}
      {...rest}
    />
  );
}
