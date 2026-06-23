import { cn } from "@marquee/ui";

export interface PageHeaderProps {
  title: string;
  /** Short context line above the title (uppercase masthead style). */
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <header
      className={cn(
        "mb-8 flex flex-col gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-6",
        className,
      )}
    >
      {eyebrow ? (
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]"
        >
          {eyebrow}
        </span>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1
          className="font-display text-[34px] leading-[1.08] tracking-[-0.01em] text-[var(--ink-primary)]"
          style={{ fontVariationSettings: "'wght' 600" }}
        >
          {title}
        </h1>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {description ? (
        <p className="font-body text-[13px] text-[var(--ink-secondary)]">{description}</p>
      ) : null}
    </header>
  );
}
