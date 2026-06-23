"use client";

/**
 * PulseDateFilter — single compact control bar that drives Pulse's
 * `?range` + `?date` query params.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ‹  ⌬ May 21, 2026  ·  Today        7d  [30d]  90d  1y   ▸ Sync  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Two coordinated controls in one inline cluster:
 *
 *   1. Date stepper — prev / next chevrons walk one day at a time
 *      around the selected `date`. The label itself is clickable and
 *      opens the native date picker (so operators can jump arbitrary
 *      distances without clicking 30 times). A small "Today" pill
 *      appears when the date == today; a separate "Today" button
 *      appears when it doesn't, so jumping back is one click.
 *      Next-day is disabled at today because there's no Pulse data
 *      from the future.
 *
 *   2. Range segmented control — 7d / 30d / 90d / 1y for KPI trend
 *      windows. Modern iOS-style pill group with a soft sunken track
 *      and an elevated "thumb" on the active token.
 *
 * All state lives in the URL. router.replace() inside startTransition()
 * gives a snappy refresh without losing scroll position, and `pending`
 * dims the bar so the operator sees that the click registered.
 *
 * No date library — we operate on `YYYY-MM-DD` strings and one UTC
 * Date construction per nav. Pulse never needs sub-day precision, and
 * pulling in a dayjs/date-fns dependency for two arithmetic ops would
 * be heavy-handed.
 */
import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@marquee/ui";

const RANGES: { token: RangeToken; label: string; hint: string }[] = [
  { token: "7d", label: "7d", hint: "Trend over last 7 days" },
  { token: "30d", label: "30d", hint: "Trend over last 30 days" },
  { token: "90d", label: "90d", hint: "Trend over last 90 days" },
  { token: "1y", label: "1y", hint: "Trend over last 12 months" },
];

export type RangeToken = "7d" | "30d" | "90d" | "1y";

interface Props {
  tenantSlug: string;
  appId: string;
  range: RangeToken;
  /** YYYY-MM-DD — defaults to today on the server. */
  date: string;
}

export function PulseDateFilter({
  tenantSlug,
  appId,
  range,
  date,
}: Props): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const today = todayIso();
  const isToday = date === today;

  function navigate(nextRange: RangeToken, nextDate: string): void {
    const params = new URLSearchParams();
    // Drop default tokens so the URL stays clean (the page mirrors the
    // same fallback in `searchParams` parsing).
    if (nextRange !== "7d") params.set("range", nextRange);
    if (nextDate !== today) params.set("date", nextDate);
    const qs = params.toString();
    const url = `/t/${tenantSlug}/apps/${appId}/pulse${qs ? `?${qs}` : ""}`;
    startTransition(() => {
      router.replace(url, { scroll: false });
    });
  }

  function shiftDay(delta: number): void {
    const d = new Date(`${date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    const next = d.toISOString().slice(0, 10);
    // Future days don't have Pulse data — clamp.
    if (next > today) return;
    navigate(range, next);
  }

  function onPickDate(event: React.ChangeEvent<HTMLInputElement>): void {
    const value = event.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    if (value > today) return;
    navigate(range, value);
  }

  // Tap the visible date pill to trigger the native picker. `showPicker`
  // is the standards-track method (Chromium, Safari TP, Firefox 101+);
  // fall back to a hidden-input click for older browsers.
  function openPicker(): void {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.click();
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-2 py-1.5",
        pending && "pointer-events-none opacity-70",
      )}
    >
      {/* ── Date stepper ─────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5">
        <IconButton
          ariaLabel="Previous day"
          onClick={() => shiftDay(-1)}
        >
          <ChevronLeft size={14} />
        </IconButton>

        <button
          type="button"
          onClick={openPicker}
          title="Pick a date"
          className="group flex items-center gap-1.5 rounded-[var(--radius)] px-2 py-1 text-[12.5px] font-medium leading-none text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-tinted)]"
        >
          <CalendarDays
            size={13}
            className="text-[var(--ink-tertiary)] group-hover:text-[var(--ink-secondary)]"
          />
          <span className="tabular-nums">{formatDate(date)}</span>
          {isToday && (
            <span className="rounded-[var(--radius-pill)] bg-[var(--signal-tint)] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--signal)]">
              Today
            </span>
          )}
        </button>

        {/* Hidden native date input — receives focus from openPicker.
            We keep it in the DOM (not just-in-time created) so
            screen-reader users can also tab to it directly. */}
        <input
          ref={inputRef}
          type="date"
          value={date}
          max={today}
          onChange={onPickDate}
          aria-label="Select date"
          // sr-only positioning so the native input doesn't render its
          // own button visually, but assistive tech can still find it.
          className="sr-only"
        />

        <IconButton
          ariaLabel="Next day"
          onClick={() => shiftDay(1)}
          disabled={isToday}
        >
          <ChevronRight size={14} />
        </IconButton>

        {!isToday && (
          <button
            type="button"
            onClick={() => navigate(range, today)}
            className="ml-1 rounded-[var(--radius)] px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--signal)] transition-colors hover:bg-[var(--signal-tint)]"
          >
            Today
          </button>
        )}
      </div>

      {/* Vertical separator — hides on narrow widths where the bar
          wraps and the divider would float orphan. */}
      <span
        aria-hidden
        className="mx-1 hidden h-5 w-px bg-[var(--stroke-soft)] sm:block"
      />

      {/* ── Range segmented control ──────────────────────────────── */}
      <div
        role="radiogroup"
        aria-label="Trend window"
        className="flex items-center gap-0.5 rounded-[var(--radius)] bg-[var(--surface-sunken)] p-0.5"
      >
        {RANGES.map((r) => {
          const active = range === r.token;
          return (
            <button
              key={r.token}
              type="button"
              role="radio"
              aria-checked={active}
              title={r.hint}
              onClick={() => navigate(r.token, date)}
              className={cn(
                "rounded-[var(--radius)] px-2.5 py-1 text-[11.5px] font-semibold leading-none tabular-nums transition-colors",
                active
                  ? "bg-[var(--surface-elevated)] text-[var(--ink-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {pending && (
        <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--ink-tertiary)]">
          loading…
        </span>
      )}
    </div>
  );
}

/** Square ghost-icon button used by the date stepper. Kept as a local
 *  primitive so the disabled state's dim-to-30% matches both arrows. */
function IconButton({
  children,
  ariaLabel,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-[var(--radius)] text-[var(--ink-tertiary)]",
        "transition-colors hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
        "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-tertiary)]",
      )}
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
