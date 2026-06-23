"use client";

/**
 * Keywords field editor — surface the app's actual `keywordsField` (the
 * comma-separated 100-char Apple budget) on the Keywords page and let
 * the operator edit + push to App Store Connect without bouncing to
 * Studio.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Keywords field · 🇺🇸 en-US                  82/100  • 12 toks │
 *   │ ┌──────────────────────────────────────────────────────────┐ │
 *   │ │ puzzle, blocks, saga, match, color, fun, brain, game…    │ │
 *   │ └──────────────────────────────────────────────────────────┘ │
 *   │ [🟢 12 tracked  🟡 2 untracked]                                │
 *   │                                                                │
 *   │     [Discard]   [Save locally]   [Push to App Store ↑]         │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * The editor reuses the same KeywordsFieldChips visualization the
 * Studio surface uses — tracked vs untracked tokens, score buckets,
 * cross-slot validation — so the operator sees one consistent chip
 * style across the app.
 *
 * Save persists the change to AppLocalization (PATCH /metadata/[locale]).
 * Push fires the existing /metadata/push endpoint scoped to that one
 * locale, which:
 *   1. Resolves / creates an editable App Store Connect version.
 *   2. Pushes the locale's full metadata payload.
 *   3. Records a MetadataSnapshot for swap-history.
 *
 * Both actions are guarded against double-clicks via the local
 * `pending` flag.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, RotateCcw, Upload, AlertCircle } from "lucide-react";
import type { KeywordWarning } from "@marquee/aso";
// IMPORTANT: import from `@marquee/core/locale` (browser-safe entry),
// NOT `@marquee/core` (server entry). The root re-exports utilities
// that pull in `node:crypto / node:stream / node:zlib`, which webpack
// then refuses to bundle for the client — see the original
// `UnhandledSchemeError: Reading from "node:crypto"`.
import { localeRegion } from "@marquee/core/locale";
import { Button, Spinner, Stamp } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { localeMeta } from "@/lib/localeMeta";
import {
  KeywordsFieldChips,
  type TrackedKeyword,
} from "@/components/metadata/MetadataEditor";
import { KeywordChipPopover } from "@/components/aso/KeywordChipPopover";

interface Props {
  appId: string;
  appName: string;
  platform: "IOS" | "ANDROID";
  locale: string;
  title: string | null;
  subtitle: string | null;
  /** Current keywords field (comma-separated, ≤100 chars on iOS). */
  initialValue: string | null;
  /** Whether the locale has unpushed local edits across any field. */
  initialDirty: boolean;
  /** Tracked keywords for this locale's storefront — overlays
   *  bucket / rank chip styling on matching tokens. */
  trackedKeywords: TrackedKeyword[];
}

export function KeywordsFieldEditor({
  appId,
  appName,
  platform,
  locale,
  title,
  subtitle,
  initialValue,
  initialDirty,
  trackedKeywords,
}: Props): JSX.Element {
  const router = useRouter();
  const [value, setValue] = useState(initialValue ?? "");
  const [dirty, setDirty] = useState(initialDirty);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [, startTransition] = useTransition();
  // Chip-click research popover — null when nothing is open. The
  // payload bundles the tracked-keyword record, the warnings attached
  // to the same token, AND the chip's DOM element. The element is
  // the popover's positioning anchor: getBoundingClientRect() drives
  // the floating placement, contains() drives outside-click dismissal.
  const [inspected, setInspected] = useState<{
    trackedKeyword: TrackedKeyword;
    warnings: KeywordWarning[];
    anchor: HTMLElement;
  } | null>(null);

  // Re-sync when the rail switches to a different locale.
  useEffect(() => {
    setValue(initialValue ?? "");
    setDirty(initialDirty);
    setTouched(false);
  }, [locale, initialValue, initialDirty]);

  const meta = localeMeta(locale);
  const maxChars = platform === "IOS" ? 100 : 200;
  // iOS counts Unicode code-points the same way Apple's tokenizer
  // does. Using [...value].length handles surrogate pairs correctly.
  const usedChars = [...value].length;
  const overBudget = usedChars > maxChars;
  const tokenCount = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0).length;

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const res = await api(
      `/api/v1/apps/${appId}/metadata/${encodeURIComponent(locale)}`,
      { method: "PATCH", body: { keywords: value || null } },
    );
    setSaving(false);
    if (!res.ok) {
      toast.error("Save failed", { description: res.message });
      return;
    }
    toast.success(`Saved ${locale} locally`, {
      description: "Push to send the change to App Store Connect.",
    });
    setTouched(false);
    setDirty(true);
    startTransition(() => router.refresh());
  };

  const handleDiscard = (): void => {
    setValue(initialValue ?? "");
    setTouched(false);
  };

  const handlePush = async (): Promise<void> => {
    if (pushing) return;
    // If the user has unsaved local edits, save them first so we don't
    // push an out-of-date version.
    if (touched) {
      await handleSave();
    }
    setPushing(true);
    const res = await api<{
      ok: boolean;
      pushed?: number;
      results?: { locale: string; success: boolean; detail: string }[];
      message?: string;
    }>(`/api/v1/apps/${appId}/metadata/push`, {
      method: "POST",
      body: { locales: [locale], includeVersionSettings: false },
    });
    setPushing(false);
    if (!res.ok) {
      toast.error("Push failed", { description: res.message });
      return;
    }
    const result = res.data.results?.find((r) => r.locale === locale);
    if (result && !result.success) {
      toast.error(`Push rejected by ${platform === "IOS" ? "App Store Connect" : "Google Play"}`, {
        description: result.detail,
      });
      return;
    }
    toast.success(`Pushed ${locale} to ${platform === "IOS" ? "App Store Connect" : "Google Play"}`, {
      description: result?.detail ?? "Metadata is now live in the store.",
    });
    setDirty(false);
    startTransition(() => router.refresh());
  };

  // Three-stage usage tone for the char pill + progress strip:
  //   • Tertiary ink under 80 % — keep it quiet, no value yet.
  //   • Warning amber 80 – 100 % — running out of room.
  //   • Danger red over 100 % — Apple will reject the push.
  const usagePct = maxChars > 0 ? Math.min(100, (usedChars / maxChars) * 100) : 0;
  const usageTone: "ok" | "warn" | "danger" = overBudget
    ? "danger"
    : usedChars > maxChars - 10
      ? "warn"
      : "ok";
  const usageFg =
    usageTone === "danger"
      ? "var(--status-danger)"
      : usageTone === "warn"
        ? "var(--status-warning)"
        : "var(--ink-tertiary)";
  const usageBg =
    usageTone === "danger"
      ? "var(--status-danger-tint)"
      : usageTone === "warn"
        ? "var(--status-warning-tint)"
        : "var(--surface-tinted)";
  const pushPlatformShort = platform === "IOS" ? "App Store" : "Play Store";
  const pushPlatformFull = platform === "IOS" ? "App Store Connect" : "Google Play";

  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
      {/* ── Header: title · live char usage · Pending Push pill ─────
       *  Single compact row instead of two stacks. The char pill carries
       *  its own usage tone (ok → warn → danger) so the operator gets a
       *  peripheral signal as they type. */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-[18px] leading-none">
            {meta.flag}
          </span>
          <span
            className="truncate font-display text-[15px] leading-none tracking-[-0.005em] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            Keywords field
          </span>
          <span className="truncate text-[12px] text-[var(--ink-tertiary)]">
            {meta.name}
          </span>
          {dirty && (
            <Stamp variant="warning" className="shrink-0">
              Pending Push
            </Stamp>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 font-mono text-[11px] font-semibold leading-none tabular-nums"
            style={{ background: usageBg, color: usageFg }}
            title={`${usedChars.toString()} of ${maxChars.toString()} characters used`}
          >
            <span
              aria-hidden
              className="block h-1.5 w-1.5 rounded-full"
              style={{ background: usageFg }}
            />
            {usedChars}/{maxChars}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-[var(--ink-tertiary)]">
            {tokenCount.toString()} token{tokenCount === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {/* Hairline char-usage progress bar — sits flush at the bottom
       *  edge of the header. 2 px high, full-width, animates color from
       *  ink-tertiary to warning to danger as the operator types. The
       *  Apple-budget exceeded state stays at 100 % red so the visual
       *  goes solid before the warning text spells it out. */}
      <div className="relative h-[2px] w-full overflow-hidden bg-[var(--surface-tinted)]">
        <span
          aria-hidden
          className="block h-full transition-[width,background-color] duration-200 ease-out"
          style={{ width: `${usagePct.toString()}%`, background: usageFg }}
        />
      </div>

      <div className="px-5 pt-4 pb-5">
        <KeywordsFieldChips
          value={value}
          onChange={(v) => {
            setValue(v);
            setTouched(true);
          }}
          maxChars={maxChars}
          tracked={trackedKeywords}
          appName={appName}
          title={title}
          subtitle={subtitle}
          onInspect={(payload) => setInspected(payload)}
        />

        {overBudget && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius)] bg-[var(--status-danger-tint)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--status-danger)]">
            <AlertCircle size={12} />
            Over {maxChars} characters — {pushPlatformFull} will reject the push.
          </div>
        )}
      </div>

      {/* ── Action bar: buttons only, right-aligned ──────────────────
       *  The previous "Save locally persists changes / Push sends them
       *  to App Store Connect" paragraph was removed — the labels +
       *  per-button title tooltips carry the meaning, and the paragraph
       *  was load-bearing for nothing on every render. */}
      <div className="flex items-center justify-end gap-2 border-t border-[var(--stroke-soft)] bg-[var(--surface-sunken)] px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDiscard}
          disabled={!touched || saving || pushing}
          title="Revert unsaved edits"
        >
          <RotateCcw size={12} /> Discard
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleSave()}
          disabled={!touched || saving || pushing || overBudget}
          title="Persist this locale's keywords field to your workspace"
        >
          {saving ? <Spinner size={12} /> : <Save size={12} />}
          Save locally
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handlePush()}
          disabled={pushing || saving || overBudget || (!dirty && !touched)}
          title={
            !dirty && !touched
              ? "No unpushed changes for this locale"
              : `Push ${locale} to ${pushPlatformFull}`
          }
        >
          {pushing ? <Spinner size={12} /> : <Upload size={12} />}
          Push to {pushPlatformShort}
        </Button>
      </div>

      {/* Chip → anchored research popover. Renders via a portal to
       *  document.body so it can escape the editor's overflow + z-
       *  index stacking. Territory is derived from the locale code
       *  via `localeRegion` (en-US → US, fr-FR → FR), matching how
       *  Astro stores rankings per storefront. */}
      {inspected && (
        <KeywordChipPopover
          appId={appId}
          keywordId={inspected.trackedKeyword.id}
          keywordText={inspected.trackedKeyword.keyword}
          territory={localeRegion(locale)}
          warnings={inspected.warnings}
          anchor={inspected.anchor}
          onClose={() => setInspected(null)}
        />
      )}
    </section>
  );
}
