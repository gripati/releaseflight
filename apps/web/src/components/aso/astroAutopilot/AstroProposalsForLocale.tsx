"use client";

/**
 * Per-locale Astro proposals section. Rendered INSIDE MetadataEditor
 * directly under the keywords field for whichever locale the user has
 * selected — so the user sees Astro's weak → strong recommendations
 * in the same visual context as the field they're editing.
 *
 * Each proposal row is:
 *   • Compact: weak word (struck-through) → strong word, score delta,
 *     popularity badge, kind stamp (DECAY → AUTO, OPPORTUNITY, or ADD
 *     for OPPORTUNITY_NEW which is a fresh add — no weak side).
 *   • Selectable: checkbox controls inclusion in the "Apply selected"
 *     button. DECAY rows are pre-checked; OPPORTUNITY_NEW (fresh adds)
 *     are not — the user opts each one in.
 *   • Clickable: the strong keyword opens the KeywordDetailPopover via
 *     the parent's `onInspectKeyword` callback so the user can drill
 *     into Astro signals, Apple popularity, trends, rank etc.
 *
 * Applying a swap mutates the keywords field IN THE EDITOR (via the
 * `onApplyToField` callback) so the user can see the diff immediately
 * AND keeps "dirty" state — final save happens through the normal
 * Save / Push flow, not the Astro endpoint. This way one-keyword swaps
 * blend with manual edits and AI rewrites in the same review surface.
 */
import { useState } from "react";
import { Button, Checkbox, Spinner, Stamp, cn } from "@marquee/ui";
import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useAstroAutopilot } from "./AstroAutopilotProvider";
import type { AstroSwapProposal } from "./types";

interface Props {
  locale: string;
  /** Current keywords field value the user is editing. */
  currentKeywordsField: string;
  /** Called when the user applies a swap — the editor updates the
   *  in-memory field value. The Astro apply endpoint is NOT called
   *  here; that's only used by "Auto-fix all DECAY" at the page level.
   *  Local apply keeps the editor's dirty model consistent. */
  onApplyToField: (newField: string) => void;
  /** Called when a keyword is clicked — opens the keyword detail
   *  popover the editor already manages. */
  onInspectKeyword?: (keyword: string, isTracked: boolean) => void;
}

export function AstroProposalsForLocale({
  locale,
  currentKeywordsField,
  onApplyToField,
  onInspectKeyword,
}: Props): JSX.Element | null {
  const {
    proposalsForLocale,
    selected,
    toggleProposal,
    setLocaleSelection,
    phase,
    astroConfigured,
    perLocaleAnalyzedAt,
    isLocaleAnalyzing,
    runAnalyze,
  } = useAstroAutopilot();
  const [collapsed, setCollapsed] = useState(false);

  if (!astroConfigured) return null;
  const bucket = proposalsForLocale(locale);
  const analyzing = isLocaleAnalyzing(locale);
  const analyzedAt = perLocaleAnalyzedAt[locale] ?? null;
  // Treat "any analyze running for this app" as a block to prevent the
  // user from queuing parallel runs that will collide with Astro's rate
  // limit. The de-dup is enforced server-side too — this just hides the
  // CTA so we don't lie to the user.
  const anyJobRunning = phase === "queued" || phase === "running";

  // ── Empty-state surface ─────────────────────────────────────────────
  // No proposals yet: either never analyzed, or this locale's run had
  // nothing to swap. Either way we render a compact CTA card so the
  // per-locale Analyze button is always discoverable next to the field.
  if (!bucket || bucket.proposals.length === 0) {
    return (
      <EmptyStateCard
        locale={locale}
        analyzedAt={analyzedAt}
        analyzing={analyzing}
        anyJobRunning={anyJobRunning}
        onAnalyze={() => void runAnalyze(locale)}
        kind={!bucket ? "never_run" : "empty"}
      />
    );
  }

  const picks = selected[locale] ?? new Set<number>();
  const autoCount = bucket.proposals.filter((p) => p.kind === "DECAY_AUTO").length;
  const oppCount = bucket.proposals.filter(
    (p) => p.kind === "OPPORTUNITY_PREVIEW",
  ).length;
  const newCount = bucket.proposals.filter((p) => p.kind === "OPPORTUNITY_NEW").length;
  const swapCount = bucket.proposals.length - newCount;

  return (
    <div className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)]">
      <header className="flex flex-wrap items-center gap-3 border-b-[0.5px] border-[var(--stroke-default)] px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--ink-primary)]"
        >
          {collapsed ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
          Astro · {bucket.proposals.length.toString()} suggestion
          {bucket.proposals.length === 1 ? "" : "s"}
          {swapCount > 0 && newCount > 0 && (
            <span className="font-mono text-[10px] normal-case tracking-normal text-[var(--ink-tertiary)]">
              ({swapCount.toString()} swap · {newCount.toString()} new)
            </span>
          )}
        </button>
        {autoCount > 0 && (
          <Stamp variant="warning">{autoCount.toString()} DECAY</Stamp>
        )}
        {oppCount > 0 && (
          <Stamp variant="default">{oppCount.toString()} OPPORTUNITY</Stamp>
        )}
        {newCount > 0 && (
          <Stamp variant="default">{newCount.toString()} ADD</Stamp>
        )}
        <FreshnessChip analyzedAt={analyzedAt} analyzing={analyzing} />
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setLocaleSelection(
                locale,
                new Set(bucket.proposals.map((_, i) => i)),
              )
            }
          >
            Select all
          </Button>
          {picks.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLocaleSelection(locale, new Set())}
            >
              Clear ({picks.size.toString()})
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runAnalyze(locale)}
            disabled={anyJobRunning}
            title={
              anyJobRunning
                ? "Another Astro analysis is running — wait for it to finish."
                : `Re-run Astro analysis for ${locale} only. Faster than analysing every locale.`
            }
          >
            {analyzing ? <Spinner className="h-3 w-3" /> : <RefreshCw size={12} />}
            <span className="ml-1.5">
              {analyzing ? "Analysing…" : `Re-analyze ${locale}`}
            </span>
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const after = applyPicksLocally(
                currentKeywordsField,
                bucket.proposals,
                picks,
              );
              onApplyToField(after);
              setLocaleSelection(locale, new Set());
            }}
            disabled={picks.size === 0}
            title="Apply the checked swaps to the keywords field. Save locally to keep."
          >
            Apply selected ({picks.size.toString()})
          </Button>
        </span>
      </header>

      {!collapsed && (
        <ul className="divide-y-[0.5px] divide-[var(--stroke-default)]">
          {bucket.proposals.map((p, i) => (
            <ProposalRow
              key={i}
              proposal={p}
              checked={picks.has(i)}
              onToggle={() => toggleProposal(locale, i)}
              onInspect={(kw, isTracked) => onInspectKeyword?.(kw, isTracked)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Single proposal row ──────────────────────────────────────────────

function ProposalRow({
  proposal,
  checked,
  onToggle,
  onInspect,
}: {
  proposal: AstroSwapProposal;
  checked: boolean;
  onToggle: () => void;
  onInspect: (keyword: string, isTracked: boolean) => void;
}): JSX.Element {
  const isAuto = proposal.kind === "DECAY_AUTO";
  const isNew = proposal.kind === "OPPORTUNITY_NEW";
  return (
    <li
      className={cn(
        "grid grid-cols-[20px_1fr_auto_auto_auto] items-center gap-3 px-3 py-1.5 text-left",
        isAuto && "bg-[var(--status-warning-tint)]",
        // Subtle tint for fresh-add rows so they don't visually melt into
        // the swap rows. Uses the same "info" tint the editor reserves
        // for non-destructive suggestions.
        isNew && "bg-[var(--status-info-tint)]",
      )}
    >
      <Checkbox
        size="sm"
        checked={checked}
        onChange={onToggle}
        title={
          isAuto
            ? "DECAY auto-swap — pre-checked. Uncheck to exclude from Apply selected."
            : isNew
              ? "Fresh app-relevant add — no weak side to retire. Tick to append to the field."
              : "Select to include in Apply selected."
        }
      />

      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--ink-primary)]">
          {proposal.weak ? (
            <>
              <button
                type="button"
                className="text-[var(--ink-tertiary)] line-through hover:text-[var(--ink-secondary)]"
                onClick={() => onInspect(proposal.weak!.keyword, true)}
                title={`Inspect ${proposal.weak.keyword}`}
              >
                {proposal.weak.keyword}
              </button>
              <span className="text-[var(--ink-tertiary)]">→</span>
            </>
          ) : (
            <span
              aria-label="add to field"
              className="font-semibold text-[var(--status-info)]"
            >
              +
            </span>
          )}
          <button
            type="button"
            className="font-medium text-[var(--ink-primary)] hover:underline"
            onClick={() => onInspect(proposal.strong.keyword, false)}
            title={`Inspect ${proposal.strong.keyword}`}
          >
            {proposal.strong.keyword}
          </button>
        </p>
        <p className="mt-0.5 truncate font-body text-[11px] text-[var(--ink-secondary)]">
          {proposal.rationale}
        </p>
      </div>

      <span
        className="font-mono text-[10px] tabular-nums text-[var(--ink-tertiary)]"
        title={
          isNew
            ? "Predicted composite score (0–1). New adds don't have a weak side to compare against, so this is the absolute score, not a delta."
            : "Score uplift over the weak keyword (newScore − oldScore, 0–1)."
        }
      >
        {isNew ? proposal.scoreDelta.toFixed(2) : `+${proposal.scoreDelta.toFixed(2)}`}
      </span>

      <AstroSignalBadges astro={proposal.strong.astro} />

      {isAuto ? (
        <Stamp variant="warning">DECAY → AUTO</Stamp>
      ) : isNew ? (
        <Stamp variant="default">ADD</Stamp>
      ) : (
        <Stamp variant="default">OPPORTUNITY</Stamp>
      )}
    </li>
  );
}

function AstroSignalBadges({
  astro,
}: {
  astro: AstroSwapProposal["strong"]["astro"];
}): JSX.Element {
  const parts: string[] = [];
  if (astro.popularity != null) parts.push(`pop ${astro.popularity.toFixed(0)}`);
  if (astro.difficulty != null) parts.push(`diff ${astro.difficulty.toString()}`);
  if (astro.volume != null) parts.push(`vol ${astro.volume.toString()}`);
  if (astro.maxReachChance != null) {
    parts.push(`reach ${astro.maxReachChance.toString()}`);
  }
  return (
    <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-[var(--ink-secondary)]">
      {parts.length > 0 ? parts.join(" · ") : "—"}
    </span>
  );
}

// ── Local apply engine ───────────────────────────────────────────────
//
// The page-level "Auto-fix all DECAY" button hits the apply endpoint
// (worker-validated, persisted, atomic). Per-locale "Apply selected"
// instead mutates the keywords field IN THE EDITOR so the user can
// review the diff alongside manual edits / AI rewrites. The Save
// button on the editor commits everything together.

function applyPicksLocally(
  currentField: string,
  proposals: AstroSwapProposal[],
  picks: Set<number>,
): string {
  if (picks.size === 0) return currentField;
  const tokens = parseTokens(currentField);
  const lowerIndex = new Map<string, number>();
  tokens.forEach((t, i) => lowerIndex.set(t.toLowerCase(), i));
  const appendQueue: string[] = [];

  for (const idx of picks) {
    const p = proposals[idx];
    if (!p) continue;
    const strong = p.strong.keyword;
    const strongLower = strong.toLowerCase();
    if (lowerIndex.has(strongLower)) continue; // already in field

    if (p.weak) {
      const weakIdx = lowerIndex.get(p.weak.keyword.toLowerCase());
      if (weakIdx !== undefined) {
        tokens[weakIdx] = strong;
        lowerIndex.delete(p.weak.keyword.toLowerCase());
        lowerIndex.set(strongLower, weakIdx);
        continue;
      }
    }
    appendQueue.push(strong);
    lowerIndex.set(strongLower, tokens.length + appendQueue.length - 1);
  }

  // Compose: appended (high-value) tokens go to the front. Trim from
  // end on cap overflow so older tokens fall off first.
  const composed = [...appendQueue, ...tokens];
  const MAX = 100;
  const final: string[] = [];
  let chars = 0;
  for (const t of composed) {
    const cost = (final.length === 0 ? 0 : 1) + t.length;
    if (chars + cost > MAX) continue;
    final.push(t);
    chars += cost;
  }
  return final.join(",");
}

function parseTokens(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ── Empty-state card ─────────────────────────────────────────────────
//
// Shown when the locale has no proposals — either because no analyze
// run has ever covered it (kind="never_run") or because the most recent
// run found nothing to swap (kind="empty"). Both surface the per-locale
// Analyze CTA so the action is always one click away from the field.

function EmptyStateCard({
  locale,
  analyzedAt,
  analyzing,
  anyJobRunning,
  onAnalyze,
  kind,
}: {
  locale: string;
  analyzedAt: string | null;
  analyzing: boolean;
  anyJobRunning: boolean;
  onAnalyze: () => void;
  kind: "never_run" | "empty";
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-3 py-2">
      <Sparkles size={12} className="text-[var(--ink-tertiary)]" />
      <p className="font-mono text-[11px] text-[var(--ink-secondary)]">
        {kind === "never_run" ? (
          <>Astro · no analysis yet for <strong>{locale}</strong>.</>
        ) : (
          // After Phase-2 metadata-seeded mining + OPPORTUNITY_NEW, an
          // empty result genuinely means Astro returned nothing app-
          // relevant for this storefront — not that the field is "balanced".
          // Re-running may help when Astro adds new entries / when the
          // app's metadata changes.
          <>Astro · no app-relevant suggestions for <strong>{locale}</strong> right now.</>
        )}
      </p>
      <FreshnessChip analyzedAt={analyzedAt} analyzing={analyzing} />
      <Button
        size="sm"
        variant="ghost"
        onClick={onAnalyze}
        disabled={anyJobRunning}
        className="ml-auto"
        title={
          anyJobRunning
            ? "Another Astro analysis is running — wait for it to finish."
            : `Run Astro analysis for ${locale} only.`
        }
      >
        {analyzing ? <Spinner className="h-3 w-3" /> : <Sparkles size={12} />}
        <span className="ml-1.5">
          {analyzing
            ? `Analysing ${locale}…`
            : kind === "never_run"
              ? `Analyze ${locale}`
              : `Re-analyze ${locale}`}
        </span>
      </Button>
    </div>
  );
}

// ── Freshness chip ────────────────────────────────────────────────────
//
// Renders "5m ago", "2h ago", "3d ago" so the user can tell at a glance
// whether the locale's proposals are fresh or stale. Computed at mount
// — exact precision isn't worth a re-render loop.

function FreshnessChip({
  analyzedAt,
  analyzing,
}: {
  analyzedAt: string | null;
  analyzing: boolean;
}): JSX.Element | null {
  if (analyzing) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--signal)]">
        <Spinner className="h-2.5 w-2.5" />
        Running
      </span>
    );
  }
  if (!analyzedAt) return null;
  const label = relativeFreshness(analyzedAt);
  if (!label) return null;
  return (
    <span
      title={`Last analyzed ${new Date(analyzedAt).toLocaleString()}`}
      className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]"
    >
      {label}
    </span>
  );
}

/** Returns a compact relative-time label ("5m ago", "2h ago", "3d ago").
 *  Returns null when the input can't be parsed so callers can skip rendering. */
function relativeFreshness(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffSeconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSeconds < 60) return "just now";
  const m = Math.floor(diffSeconds / 60);
  if (m < 60) return `${m.toString()}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h.toString()}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d.toString()}d ago`;
  const w = Math.floor(d / 7);
  return `${w.toString()}w ago`;
}
