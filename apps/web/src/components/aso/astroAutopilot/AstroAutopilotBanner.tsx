"use client";

/**
 * Top-of-page status banner for the Astro autopilot. Stays minimal:
 *
 *   • One settings chip — popularity / difficulty floor & ceiling.
 *     Click expands the slider panel.
 *   • One primary action — "Analyze all locales" (multi-locale batch).
 *     The actual per-locale work lives in MetadataEditor as a single
 *     button next to each keywords field.
 *   • Inline status — proposal counts, last run age, in-flight
 *     progress.
 *
 * Removed (intentionally):
 *   • The "Auto-fix N DECAY" bulk button — swaps are now an explicit,
 *     reviewed decision per keyword, not a one-click avalanche.
 *   • The per-locale weak→strong copy block — that detail belongs
 *     inside the keyword field card, not the global banner.
 */
import { Card, Spinner, Stamp, Button, cn } from "@marquee/ui";
import { Sparkles, Database, Sliders } from "lucide-react";
import { useState } from "react";
import { useAstroAutopilot } from "./AstroAutopilotProvider";

interface Props {
  tenantSlug: string;
}

export function AstroAutopilotBanner({ tenantSlug }: Props): JSX.Element {
  const {
    astroConfigured,
    data,
    job,
    phase,
    minPopularity,
    maxDifficulty,
    setMinPopularity,
    setMaxDifficulty,
    runAnalyze,
    // applyAutoDecay + applyingAuto deliberately not destructured —
    // the bulk auto-fix UI has been removed. Provider still exposes
    // them for any non-banner caller.
  } = useAstroAutopilot();
  const [filtersOpen, setFiltersOpen] = useState(false);

  if (astroConfigured === null) {
    return (
      <Card>
        <div className="flex items-center gap-3 py-2">
          <Spinner className="h-3 w-3" />
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            Checking Astro connection…
          </span>
        </div>
      </Card>
    );
  }

  if (!astroConfigured) {
    return (
      <Card className="border-dashed">
        <div className="flex flex-wrap items-center gap-3 py-1">
          <Database size={16} className="text-[var(--ink-tertiary)]" />
          <div className="flex-1">
            <p className="font-display text-[15px] leading-tight">Astro Autopilot</p>
            <p className="font-body text-[12px] text-[var(--ink-secondary)]">
              Connect Astro Desktop to discover stronger per-locale keyword swaps
              — competitor mining, locale-language transcreation, DECAY auto-fix.
            </p>
          </div>
          <a
            href={`/t/${tenantSlug}/credentials`}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--ink-primary)] bg-[var(--ink-primary)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--surface-paper)] hover:opacity-90"
          >
            Connect Astro
          </a>
        </div>
      </Card>
    );
  }

  const isInflight = phase === "queued" || phase === "running";
  const pct =
    isInflight && job && job.progress.total > 0
      ? Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))
      : null;
  // When an in-flight job targets specific locales, render a chip
  // ("Targeting: fr, de") so the user knows the Auto-fix button + per-
  // locale chips will only refresh those slices — not the whole app.
  const targetLocales = isInflight ? job?.targetLocales ?? null : null;
  const targetLabel =
    targetLocales && targetLocales.length > 0
      ? targetLocales.length <= 3
        ? targetLocales.join(", ")
        : `${targetLocales.slice(0, 2).join(", ")} +${(targetLocales.length - 2).toString()}`
      : null;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles size={16} className="text-[var(--signal)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-display text-[15px] leading-tight">Astro Autopilot</p>
            {data && (
              <Stamp variant="default">
                {data.totals.proposals.toString()} proposals across{" "}
                {data.recommendationsByLocale.length.toString()} locales
              </Stamp>
            )}
            {targetLabel && (
              <Stamp variant="default" title={`Targeting locales: ${targetLocales!.join(", ")}`}>
                Targeting {targetLabel}
              </Stamp>
            )}
            {isInflight && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--ink-tertiary)]">
                <Spinner className="h-3 w-3" />
                {job?.progress.step ?? "Running…"}
                {pct !== null && ` · ${pct.toString()}%`}
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            {data
              ? `Last run ${(data.durationMs / 1000).toFixed(1)}s · per-locale Analyze available in each keywords field`
              : isInflight
                ? "Running in background — you can navigate away"
                : "Set your popularity / difficulty thresholds, then Analyze all locales at once"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFiltersOpen((o) => !o)}
            title="Adjust the realistic-target filter (popularity floor + difficulty ceiling)."
          >
            <Sliders size={12} />
            <span className="ml-1.5">
              pop ≥ {minPopularity.toString()} · diff ≤ {maxDifficulty.toString()}
            </span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void runAnalyze()}
            disabled={isInflight || phase === "loading"}
            title="Mine + score keyword suggestions for every locale at once. Use the per-locale Analyze button next to a single keyword field to refresh just one language."
          >
            {phase === "loading" || isInflight ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <Sparkles size={12} />
            )}
            <span className="ml-1.5">
              {phase === "loading" && "Loading…"}
              {phase === "idle" && (data ? "Re-analyze all locales" : "Analyze all locales")}
              {phase === "queued" && "Queued"}
              {phase === "running" && "Running"}
              {phase === "done" && "Re-analyze all locales"}
            </span>
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div className="mt-3 grid gap-3 rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-3 py-2 sm:grid-cols-2">
          <FilterControl
            label="Popularity floor"
            hint="Apple's 0-100 search index. 25 = drops dead-tail terms; 50 = surface meaningful demand."
            value={minPopularity}
            min={0}
            max={100}
            step={5}
            onChange={setMinPopularity}
            valueSuffix=""
          />
          <FilterControl
            label="Difficulty ceiling"
            hint="Apple's 0-100 keyword difficulty. 60 = winnable for new apps; 80 = competitive for established apps."
            value={maxDifficulty}
            min={0}
            max={100}
            step={5}
            onChange={setMaxDifficulty}
            valueSuffix=""
          />
          <p className="font-body text-[10px] text-[var(--ink-tertiary)] sm:col-span-2">
            Filters apply on the NEXT analyze run. Click <strong>Re-run</strong> to
            mine fresh candidates with your new thresholds.
          </p>
        </div>
      )}

      {pct !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-tinted)]">
          <div
            className={cn("h-full bg-[var(--signal)] transition-all")}
            style={{ width: `${pct.toString()}%` }}
          />
        </div>
      )}
    </Card>
  );
}

function FilterControl({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  valueSuffix,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  valueSuffix: string;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-secondary)]">
        {label}
        <span className="font-mono text-[12px] tabular-nums text-[var(--ink-primary)]">
          {value.toString()}
          {valueSuffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full accent-[var(--signal)]"
      />
      <span className="font-body text-[10px] text-[var(--ink-tertiary)]">{hint}</span>
    </label>
  );
}
