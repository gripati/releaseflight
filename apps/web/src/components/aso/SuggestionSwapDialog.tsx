"use client";

/**
 * Small modal that asks the user which existing keyword to retire
 * when adopting an Astro suggestion. Triggered from the suggestion
 * card's "Swap…" button.
 *
 * Inputs:
 *   • the new suggested keyword + its signals (popularity, difficulty,
 *     AI relevance) so the user sees what they're adopting
 *   • the territory — restricts the candidate list to keywords already
 *     tracked in the same storefront (you can only 1-for-1 swap within
 *     a single storefront)
 *
 * On confirm: POST /api/v1/apps/[appId]/aso/keywords/swap.
 * On success: caller's `onSwapped(newKeywordId)` is invoked so the
 * parent can refresh the suggestion list + scroll to the new row.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@marquee/ui";
import { territoryFlag, territoryName } from "@marquee/core/locale";

interface CandidateKeyword {
  id: string;
  keyword: string;
  /** Tag list — used to highlight default vs already-adopted rows. */
  tags: string[];
  /** Latest signal numbers so the user can pick a WEAK keyword to
   *  replace rather than a strong one. */
  latestRank: number | null;
  latestScore: number | null;
  latestBucket: string | null;
}

export interface SuggestionPayload {
  keyword: string;
  territory: string;
  popularity: number | null;
  difficulty: number | null;
  appsCount: number | null;
  aiRelevance: number | null;
  aiReason: string | null;
}

interface SuggestionSwapDialogProps {
  appId: string;
  suggestion: SuggestionPayload;
  /** Candidates to replace (same territory, status=ACTIVE). */
  candidates: CandidateKeyword[];
  onClose: () => void;
  onSwapped: (newTrackedKeywordId: string) => void;
}

export function SuggestionSwapDialog({
  appId,
  suggestion,
  candidates,
  onClose,
  onSwapped,
}: SuggestionSwapDialogProps): JSX.Element {
  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Default to the weakest candidate (highest rank number / lowest
  // score) — the typical "swap out the deadweight" use case.
  useEffect(() => {
    if (selectedId !== null || candidates.length === 0) return;
    const weakest = [...candidates].sort((a, b) => {
      const ra = a.latestRank ?? 999;
      const rb = b.latestRank ?? 999;
      return rb - ra;
    })[0];
    if (weakest) setSelectedId(weakest.id);
  }, [candidates, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
      const csrf = (await csrfRes.json()) as { csrfToken: string };
      const res = await fetch(`/api/v1/apps/${appId}/aso/keywords/swap`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken },
        body: JSON.stringify({
          oldTrackedKeywordId: selectedId,
          newKeyword: suggestion.keyword,
          notes: suggestion.aiReason
            ? `Adopted from Astro suggestion · ${suggestion.aiReason}`
            : "Adopted from Astro suggestion",
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { newTrackedKeywordId: string }
        | { error: { message: string } }
        | null;
      if (!res.ok) {
        const msg =
          data && "error" in data ? data.error.message : `HTTP ${res.status.toString()}`;
        setError(msg);
        return;
      }
      if (data && "newTrackedKeywordId" in data) {
        onSwapped(data.newTrackedKeywordId);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed");
    } finally {
      setBusy(false);
    }
  };

  if (!mounted) return <></>;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[100] bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "fixed left-1/2 top-1/2 z-[101] w-[min(520px,92vw)]",
          "-translate-x-1/2 -translate-y-1/2",
          "flex flex-col rounded-[var(--radius-sm)] border border-[var(--stroke-default)]",
          "bg-[var(--surface-elevated)] shadow-[0_8px_24px_rgba(0,0,0,0.12)]",
        )}
      >
        {/* Header — show what we're adopting + signal stats */}
        <header className="border-b border-[var(--stroke-default)] px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
              Adopt suggestion
            </span>
            <span className="ml-auto" aria-hidden>
              {territoryFlag(suggestion.territory)}
            </span>
            <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
              {territoryName(suggestion.territory)}
            </span>
          </div>
          <h3 className="mt-1 font-display text-lg">{suggestion.keyword}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <SignalChip label="Popularity" value={suggestion.popularity} />
            <SignalChip
              label="Difficulty"
              value={suggestion.difficulty}
              tone={
                suggestion.difficulty == null
                  ? undefined
                  : suggestion.difficulty <= 35
                    ? "positive"
                    : suggestion.difficulty <= 65
                      ? undefined
                      : "negative"
              }
            />
            <SignalChip label="Apps" value={suggestion.appsCount} />
            <SignalChip
              label="AI relevance"
              value={suggestion.aiRelevance}
              tone={
                suggestion.aiRelevance == null
                  ? undefined
                  : suggestion.aiRelevance >= 70
                    ? "positive"
                    : suggestion.aiRelevance >= 40
                      ? undefined
                      : "negative"
              }
            />
          </div>
          {suggestion.aiReason ? (
            <p className="mt-2 text-[11px] italic text-[var(--ink-secondary)]">
              {suggestion.aiReason}
            </p>
          ) : null}
        </header>

        {/* Candidate list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
            Replace which existing keyword?
          </div>
          {candidates.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-tertiary)]">
              No active keywords in {territoryName(suggestion.territory)}. Track at least one
              keyword in this storefront before adopting suggestions.
            </p>
          ) : (
            <ul className="space-y-1">
              {candidates.map((c) => {
                const isDefault = c.tags.map((t) => t.toLowerCase()).includes("default");
                const isSelected = selectedId === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        "grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-3 rounded-[var(--radius-xs)] border px-2.5 py-1.5 text-left",
                        isSelected
                          ? "border-[var(--ink-primary)] bg-[var(--surface-tinted)]"
                          : "border-[var(--stroke-soft)] hover:bg-[var(--surface-tinted)]/40",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "inline-block h-3 w-3 rounded-full border",
                          isSelected
                            ? "border-[var(--ink-primary)] bg-[var(--ink-primary)]"
                            : "border-[var(--stroke-strong)]",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="truncate text-[12px] font-semibold">
                          {c.keyword}
                        </span>
                        <span className="ml-1.5 font-mono text-[9px] uppercase text-[var(--ink-tertiary)]">
                          {isDefault ? "default" : "tracked"}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[var(--ink-tertiary)]">
                        {c.latestRank != null ? `#${c.latestRank.toString()}` : "off"}
                        {c.latestBucket ? ` · ${c.latestBucket.toLowerCase()}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center gap-3 border-t border-[var(--stroke-default)] px-4 py-2">
          {error ? (
            <span className="text-[11px] tone-negative">{error}</span>
          ) : (
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
              {selectedId ? "Ready to swap" : "Pick a keyword to retire"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ml-auto text-[11px] text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !selectedId || candidates.length === 0}
            className="rounded-[var(--radius-xs)] bg-[var(--ink-primary)] px-3 py-1 text-[11px] font-medium text-[var(--surface-paper)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Swapping…" : "Confirm swap"}
          </button>
        </footer>
      </div>
    </>,
    document.body,
  );
}

function SignalChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: "positive" | "negative";
}): JSX.Element {
  const valueClass =
    tone === "positive"
      ? "tone-positive"
      : tone === "negative"
        ? "tone-negative"
        : "";
  return (
    <span className="inline-flex items-baseline gap-1 rounded-[var(--radius-xs)] border border-[var(--stroke-soft)] px-1.5 py-0.5 font-mono text-[10px]">
      <span className="text-[var(--ink-tertiary)]">{label}</span>
      <span className={cn("tabular-nums", valueClass)}>
        {value != null ? value.toString() : "—"}
      </span>
    </span>
  );
}
