"use client";
import { Fragment } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { cn } from "@marquee/ui";

/**
 * Shared building blocks for the no-code credential setup wizards
 * (Google Play, Apple App Store Connect, …). Keeps the pipeline and instruction
 * styling consistent across providers.
 */

export interface GuideStepMeta {
  key: string;
  /** Short label shown in the pipeline tooltip. */
  pill: string;
}

export function GuidePipeline({
  steps,
  current,
  onJump,
}: {
  steps: GuideStepMeta[];
  current: number;
  onJump: (i: number) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          <button
            type="button"
            onClick={() => onJump(i)}
            title={s.pill}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors",
              i < current
                ? "bg-[var(--status-success)] text-white"
                : i === current
                  ? "bg-[var(--ink-primary)] text-[var(--surface-elevated)]"
                  : "border border-[var(--stroke-default)] bg-[var(--surface-sunken)] text-[var(--ink-tertiary)]",
            )}
          >
            {i < current ? <Check size={12} /> : i + 1}
          </button>
          {i < steps.length - 1 && (
            <div
              className={cn(
                "h-px flex-1",
                i < current ? "bg-[var(--status-success)]" : "bg-[var(--stroke-default)]",
              )}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function Instructions({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <ol className="list-decimal space-y-2 pl-5 font-body text-[13px] leading-[1.6] text-[var(--ink-secondary)] [&_code]:rounded [&_code]:bg-[var(--surface-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_strong]:text-[var(--ink-primary)]">
      {children}
    </ol>
  );
}

export function Callout({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-[var(--radius-xs)] px-3 py-2 font-body text-[12px] leading-[1.55]",
        tone === "warning"
          ? "bg-[var(--status-warning-tint)] text-[var(--status-warning)]"
          : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]",
      )}
    >
      {tone === "warning" && <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span className="[&_code]:font-mono [&_code]:text-[11px] [&_strong]:text-[var(--ink-primary)]">
        {children}
      </span>
    </div>
  );
}
