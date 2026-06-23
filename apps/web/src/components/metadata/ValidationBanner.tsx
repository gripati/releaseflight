"use client";

/**
 * ValidationBanner — surfaces every metadata field that exceeds its
 * platform character limit, with a one-click "Jump" deep-link into
 * the offending locale + field.
 *
 *   ⚠  3 fields over the App Store limit              [Review ▾]
 *   ┌────────────────────────────────────────────────────────┐
 *   │ 🇫🇷 fr-FR · Title              35 / 30   over by 17%  [Jump] │
 *   │ 🇩🇪 de-DE · Subtitle           33 / 30   over by 10%  [Jump] │
 *   │ 🇪🇸 es-ES · Promotional text  175 / 170  over by  3%  [Jump] │
 *   └────────────────────────────────────────────────────────┘
 *
 * The banner only mounts when there are violations — clean Metadata
 * pages render nothing. Pushing to the store with over-limit fields
 * is the #1 push-rejection reason, so catching it at edit time
 * (instead of after Apple rejects the submission) saves the operator
 * a wasted round-trip.
 */
import { useState } from "react";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { Button, cn } from "@marquee/ui";
import { localeMeta } from "@/lib/localeMeta";

export interface MetadataViolation {
  /** AppLocalization locale code, e.g. "fr-FR". */
  locale: string;
  /** Database column name on AppLocalization. Used to build the
   *  `field-<col>-<locale>` element id the editor renders. */
  field: string;
  /** Human-readable field label ("Title", "Keywords field", …). */
  fieldLabel: string;
  /** Current character count (Unicode code-point length). */
  charCount: number;
  /** Platform limit. */
  charLimit: number;
}

interface Props {
  violations: MetadataViolation[];
  platform: "IOS" | "ANDROID";
  /** Called with the locale + field-column when the operator clicks
   *  Jump on a row. The editor should switch to that locale, scroll
   *  the field into view, and focus it. */
  onJumpTo: (locale: string, field: string) => void;
}

export function ValidationBanner({
  violations,
  platform,
  onJumpTo,
}: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(true);

  if (violations.length === 0) return null;

  const distinctLocales = new Set(violations.map((v) => v.locale)).size;
  const storeName = platform === "IOS" ? "App Store" : "Google Play";

  return (
    <div
      role="alert"
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--status-danger)]/40 bg-[var(--status-danger-tint)]"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--status-danger)]/15 text-[var(--status-danger)]">
            <AlertTriangle size={14} />
          </span>
          <div>
            <p className="text-[13px] font-semibold text-[var(--status-danger)]">
              {violations.length.toString()} field
              {violations.length === 1 ? "" : "s"} over the {storeName} limit
            </p>
            <p className="text-[11px] text-[var(--status-danger)]/80">
              {distinctLocales.toString()} locale
              {distinctLocales === 1 ? "" : "s"} affected · push will be
              rejected until fixed
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? "Hide" : "Review"}
        </Button>
      </header>

      {expanded && (
        <ul className="border-t border-[var(--status-danger)]/20 bg-[var(--surface-elevated)]">
          {violations.map((v, i) => (
            <ViolationRow
              key={`${v.locale}::${v.field}::${i.toString()}`}
              violation={v}
              onJump={() => onJumpTo(v.locale, v.field)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ViolationRow({
  violation,
  onJump,
}: {
  violation: MetadataViolation;
  onJump: () => void;
}): JSX.Element {
  const meta = localeMeta(violation.locale);
  const overBy = violation.charCount - violation.charLimit;
  const overByPct = Math.round((overBy / violation.charLimit) * 100);
  return (
    <li className="grid grid-cols-[24px_140px_1fr_auto_auto_auto] items-center gap-3 border-t border-[var(--stroke-soft)] px-4 py-2 text-[12px] first:border-t-0">
      <span aria-hidden className="text-[14px] leading-none">
        {meta.flag}
      </span>
      <div className="min-w-0">
        <span className="block truncate font-medium text-[var(--ink-primary)]">
          {meta.name}
        </span>
      </div>
      <span className="font-medium text-[var(--ink-primary)]">
        {violation.fieldLabel}
      </span>
      <span className="font-mono text-[12px] tabular-nums text-[var(--ink-secondary)]">
        {violation.charCount}/{violation.charLimit}
      </span>
      <span
        className={cn(
          "inline-flex items-center rounded-[var(--radius-pill)] px-2 py-0.5",
          "text-[11px] font-semibold tabular-nums",
          "bg-[var(--status-danger-tint)] text-[var(--status-danger)]",
        )}
      >
        +{overBy} ({overByPct.toString()}%)
      </span>
      <Button variant="primary" size="sm" onClick={onJump}>
        Jump
        <ArrowRight size={12} />
      </Button>
    </li>
  );
}
