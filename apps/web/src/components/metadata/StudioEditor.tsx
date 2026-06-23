"use client";

/**
 * Studio — focused copy-editing workspace.
 *
 *   ┌─────────────┬──────────────────────────────────────────────────┐
 *   │ Locale rail │ Editor canvas                                     │
 *   │  (240 px)   │ (flex, scrollable)                                │
 *   │             │                                                   │
 *   │ Search      │ Locale header (flag · code · save / discard)      │
 *   │ Dirty only  │ ─────────────────────────────                     │
 *   │             │ Title (sticky)                  30/30 [Generate]  │
 *   │ ● en-US ⨯3  │   [▾ AI variants drawer when expanded]            │
 *   │ ○ fr-FR     │ Subtitle                        22/30 [Generate]  │
 *   │ ● de-DE ⨯1  │ ▸ Description (collapsed)                         │
 *   │ ○ es-ES     │ ▸ Promotional text (collapsed)                    │
 *   │             │ ▸ What's new (collapsed)                          │
 *   │             │ ▸ URLs (collapsed)                                │
 *   │             │                                                   │
 *   │             │ [Sticky save bar when dirty]                      │
 *   └─────────────┴──────────────────────────────────────────────────┘
 *
 * Scope notes:
 *   • Keywords field DOES NOT live here. It moved to the dedicated
 *     Keywords tab which owns the rail + push-to-store + Astro
 *     opportunities for that single field.
 *   • AI alternatives render INLINE under each field card when the
 *     operator clicks Generate. The legacy right-side inspector was
 *     retired — operators kept losing it when collapsed and the panel
 *     mostly mirrored what the inline drawer already showed.
 *   • Less-used fields (description, promo, what's new, URLs) collapse
 *     under a "More fields" toggle so the canvas isn't visually heavy
 *     when the 95 % case is editing the hero strings.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Save, Sparkles, Wand2 } from "lucide-react";
import { Button, Card, Input, Label, Spinner, Stamp, Textarea, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { localeMeta } from "@/lib/localeMeta";
import { LocaleStrip } from "@/components/shell/LocaleStrip";
import { FieldHint } from "./FieldHint";
import { ValidationBanner, type MetadataViolation } from "./ValidationBanner";
import {
  AiVariantsDrawer,
  FIELDS_ANDROID,
  FIELDS_IOS,
  StrengthChip,
  charCount,
  packKey,
  type EditorLocale,
  type FieldDef,
  type FieldGenerateResponse,
  type FieldKind,
  type FieldPackKey,
} from "./MetadataEditor";

// ──────────────────────────────────────────────────────────────────────
// Types + config
// ──────────────────────────────────────────────────────────────────────

type Platform = "IOS" | "ANDROID";

interface Props {
  tenantSlug: string;
  app: {
    id: string;
    platform: Platform;
    primaryLocale: string;
    appName: string;
  };
  initialLocalizations: EditorLocale[];
}

/** Database column for the keywords field. Excluded entirely — it
 *  lives on the dedicated Keywords tab so this editor stays focused on
 *  copy writing. */
const KEYWORDS_FIELD_NAME: keyof EditorLocale = "keywords";

/** Description rows in the textarea. The legacy editor used `rows: 14`
 *  which made the form scroll forever; 6 fits the typical "above-the-
 *  fold + first hook" pattern that 95 % of ASO description edits stay
 *  inside. Operators can drag the textarea handle if they need more
 *  space for a long-form rewrite. */
const DESCRIPTION_ROWS_OVERRIDE = 6;

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function StudioEditor({ tenantSlug, app, initialLocalizations }: Props): JSX.Element {
  void tenantSlug;
  const router = useRouter();
  const [locs, setLocs] = useState<EditorLocale[]>(initialLocalizations);
  const [selectedLocale, setSelectedLocale] = useState<string>(
    initialLocalizations.find((l) => l.locale === app.primaryLocale)?.locale ??
      initialLocalizations[0]?.locale ??
      app.primaryLocale,
  );
  const [savingLocale, setSavingLocale] = useState<string | null>(null);
  const [fieldPacks, setFieldPacks] = useState<Record<FieldPackKey, FieldGenerateResponse>>({});
  const [generating, setGenerating] = useState<FieldPackKey | null>(null);
  /** Per-(locale+field) inline AI-drawer open state. Key matches `packKey`. */
  const [openDrawers, setOpenDrawers] = useState<Set<FieldPackKey>>(new Set());

  const current = locs.find((l) => l.locale === selectedLocale) ?? null;
  const FIELDS_RAW = app.platform === "IOS" ? FIELDS_IOS : FIELDS_ANDROID;
  // Drop the keywords field — Keywords tab owns it now. Render every
  // other field in document order so the operator never has to expand
  // a "more fields" toggle.
  const FIELDS = useMemo(
    () =>
      FIELDS_RAW.filter((f) => f.field !== KEYWORDS_FIELD_NAME).map((f) =>
        f.field === "description" ? { ...f, rows: DESCRIPTION_ROWS_OVERRIDE } : f,
      ),
    [FIELDS_RAW],
  );
  // URL fields (marketing / support / privacy / YouTube) all share the
  // same shape — single-line input with no AI assist, no strength chip,
  // no character anxiety. Grouping them into one compact "Links" card
  // saves three full field-card frames at the bottom of the canvas.
  const urlFields = useMemo(() => FIELDS.filter((f) => f.type === "url"), [FIELDS]);
  const contentFields = useMemo(() => FIELDS.filter((f) => f.type !== "url"), [FIELDS]);

  // Every field name the platform tracks — used to detect in-progress
  // unsaved edits during prop resync. Pulled from FIELDS_RAW (not the
  // filtered FIELDS) so we include `keywords` too: the dedicated
  // Keywords tab can dirty the same AppLocalization row, and we want
  // the merge to respect that locale-wide state.
  const allFieldNames = useMemo(() => FIELDS_RAW.map((f) => f.field), [FIELDS_RAW]);

  // ── Re-sync client state on server data updates ─────────────────────
  // When AppActionsBar pushes to the store, it calls `router.refresh()`
  // after the request completes. That re-renders this component with
  // fresh `initialLocalizations` whose `dirty` flags have been cleared
  // server-side. Without this effect, the client's `locs` array stays
  // frozen at mount-time values — so the "Pending Push" stamp in the
  // canvas header and the locale rail's state dots keep showing as
  // pending forever, even after Apple / Google accept the push.
  //
  // Per-locale smart merge:
  //   • All field values match server → take server. This is the post-
  //     push case: client believes dirty=true, server now says
  //     dirty=false, and the values agree (push doesn't change content).
  //     Taking server clears the pending-push UI everywhere.
  //   • Any field value differs → keep client. The operator has typed
  //     edits that haven't been saved yet (e.g. they started editing
  //     another locale while a save in locale-A triggered a refresh).
  //     A naive overwrite here would silently wipe their typing.
  useEffect(() => {
    setLocs((prev) =>
      initialLocalizations.map((server) => {
        const client = prev.find((c) => c.locale === server.locale);
        if (!client) return server;
        const hasUnsavedEdits = allFieldNames.some((k) => client[k] !== server[k]);
        return hasUnsavedEdits ? client : server;
      }),
    );
  }, [initialLocalizations, allFieldNames]);

  // ── Locale rail entries ─────────────────────────────────────────────
  // The shared LocaleRail manages filter / dirty-only state internally;
  // we only feed it the source list with chip metadata.
  const railEntries = useMemo(
    () =>
      locs.map((l) => ({
        locale: l.locale,
        charCount: charCount(l.name),
        charLimit: app.platform === "IOS" ? 30 : 50,
        state: l.dirty ? ("dirty" as const) : ("synced" as const),
      })),
    [locs, app.platform],
  );

  // ── Validation: over-limit fields across every locale ───────────────
  // Computed client-side off the live `locs` state so the banner
  // updates instantly when the operator's edits cross or clear a
  // limit. The set drives the warning banner above the canvas + the
  // "Jump" deep-link that switches locale + scrolls to the offender.
  const violations = useMemo<MetadataViolation[]>(() => {
    const out: MetadataViolation[] = [];
    for (const loc of locs) {
      for (const f of FIELDS) {
        const raw = (loc[f.field] as string | null) ?? "";
        const count = charCount(raw);
        if (count > f.max) {
          out.push({
            locale: loc.locale,
            field: f.field,
            fieldLabel: f.label,
            charCount: count,
            charLimit: f.max,
          });
        }
      }
    }
    // Worst offenders first so the operator sees the highest-priority
    // fix at the top of the banner.
    return out.sort((a, b) => b.charCount - b.charLimit - (a.charCount - a.charLimit));
  }, [locs, FIELDS]);

  // Jump-to-field deep link: switches locale, then on the next paint
  // scrolls the offending input into view and focuses it. The two-tick
  // dance lets React re-render the new locale's field cards before we
  // try to find them in the DOM.
  const jumpToField = useCallback((locale: string, field: string): void => {
    setSelectedLocale(locale);
    const id = `field-${field}-${locale}`;
    // Two RAF ticks: first one waits for React commit, second waits
    // for the layout to settle so scrollIntoView lands on the final
    // position (not where the element transiently sat mid-render).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.focus({ preventScroll: true });
        }
      });
    });
  }, []);

  // ── Mutations ───────────────────────────────────────────────────────
  const setField = useCallback(
    <K extends keyof EditorLocale>(localeCode: string, field: K, value: EditorLocale[K]): void => {
      setLocs((prev) =>
        prev.map((l) => (l.locale === localeCode ? { ...l, [field]: value, dirty: true } : l)),
      );
    },
    [],
  );

  const saveLocal = useCallback(
    (localeCode: string): void => {
      const loc = locs.find((l) => l.locale === localeCode);
      if (!loc) return;
      setSavingLocale(localeCode);
      void (async () => {
        // We POST every field this Studio knows about. The keywords
        // field is intentionally excluded — touching it would race with
        // edits happening on the Keywords tab.
        const body: Record<string, string | null> = {};
        for (const f of FIELDS) {
          body[f.field as string] = (loc[f.field] as string | null) ?? null;
        }
        const res = await api(`/api/v1/apps/${app.id}/metadata/${encodeURIComponent(localeCode)}`, {
          method: "PATCH",
          body,
        });
        setSavingLocale(null);
        if (!res.ok) {
          toast.error("Save failed", { description: res.message });
          return;
        }
        toast.success(`Saved ${localeCode}`, {
          description: "Local edits stored — push from the app header.",
        });
        router.refresh();
      })();
    },
    [FIELDS, app.id, locs, router],
  );

  const discardLocal = useCallback(
    (localeCode: string): void => {
      setLocs((prev) =>
        prev.map((l) => {
          if (l.locale !== localeCode) return l;
          const original = initialLocalizations.find((il) => il.locale === localeCode);
          return original ? { ...original } : l;
        }),
      );
    },
    [initialLocalizations],
  );

  const toggleDrawer = useCallback((key: FieldPackKey, force?: boolean): void => {
    setOpenDrawers((prev) => {
      const next = new Set(prev);
      const target = force ?? !prev.has(key);
      if (target) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const generateForField = useCallback(
    async (localeCode: string, kind: FieldKind, count = 3): Promise<void> => {
      const key = packKey(localeCode, kind);
      setGenerating(key);
      const res = await api<FieldGenerateResponse>(
        `/api/v1/apps/${app.id}/metadata/${encodeURIComponent(localeCode)}/ai-generate`,
        { method: "POST", body: { field: kind, count } },
      );
      setGenerating(null);
      if (!res.ok) {
        toast.error(`AI generate failed (${kind})`, { description: res.message });
        return;
      }
      setFieldPacks((prev) => ({ ...prev, [key]: res.data }));
      const top = res.data.result.alternatives[0];
      toast.success(`${capitaliseLabel(kind)} alternatives ready`, {
        description: top
          ? `Top: ${top.score.toString()}/100 · ${top.verdict} · $${res.data.usage.usdCost.toFixed(4)}`
          : `${res.data.latencyMs.toString()}ms · $${res.data.usage.usdCost.toFixed(4)}`,
      });
      // Auto-expand the drawer so the operator sees results immediately.
      toggleDrawer(key, true);
    },
    [app.id, toggleDrawer],
  );

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Horizontal locale strip sits above the canvas — replaces the
       *  legacy 240 px vertical rail. Operator scans flags + ISO codes
       *  left → right; the strip horizontally scrolls when locale count
       *  exceeds the viewport. Selected chip = filled-ink pill. */}
      <LocaleStrip
        entries={railEntries}
        selected={selectedLocale}
        onSelect={(loc) => {
          if (loc) setSelectedLocale(loc);
        }}
        primaryLocale={app.primaryLocale}
      />

      <section className="min-w-0">
        {!current ? (
          <EmptyCanvas />
        ) : (
          <article className="space-y-3">
            <CanvasHeader
              locale={current}
              isPrimary={current.locale === app.primaryLocale}
              onDiscard={() => discardLocal(current.locale)}
              onSave={() => saveLocal(current.locale)}
              saving={savingLocale === current.locale}
            />

            {/* Cross-locale over-limit warnings — mounted only when
             *  violations exist. Each row deep-links to the offending
             *  field via `jumpToField`. */}
            {violations.length > 0 && (
              <ValidationBanner
                violations={violations}
                platform={app.platform}
                onJumpTo={jumpToField}
              />
            )}

            <div className="space-y-3">
              {contentFields.map((f) => (
                <FieldRow
                  key={f.field as string}
                  field={f}
                  locale={current}
                  platform={app.platform}
                  pack={f.aiKind ? (fieldPacks[packKey(current.locale, f.aiKind)] ?? null) : null}
                  drawerOpen={
                    f.aiKind !== undefined && openDrawers.has(packKey(current.locale, f.aiKind))
                  }
                  generating={
                    f.aiKind !== undefined && generating === packKey(current.locale, f.aiKind)
                  }
                  onChange={(value) => setField(current.locale, f.field, value)}
                  onGenerate={() => {
                    if (!f.aiKind) return;
                    void generateForField(current.locale, f.aiKind);
                  }}
                  onToggleDrawer={() => {
                    if (!f.aiKind) return;
                    toggleDrawer(packKey(current.locale, f.aiKind));
                  }}
                />
              ))}

              {urlFields.length > 0 && (
                <LinksCard
                  fields={urlFields}
                  locale={current}
                  onChange={(field, value) => setField(current.locale, field, value)}
                />
              )}
            </div>

            {/* The sticky save-bar that used to live here was retired —
             *  CanvasHeader already exposes Discard + Save locally with
             *  the Pending Push pill, so the footer was duplicate UI
             *  taking up screen space at the bottom edge. */}
          </article>
        )}
      </section>
    </div>
  );
}

// The locale rail itself moved into `@/components/shell/LocaleRail`
// so Metadata, Keywords, Screenshots, and Previews all share one
// implementation. This file just builds the entries + wires the
// React-state model into that shared component (see render block).

// ──────────────────────────────────────────────────────────────────────
// Canvas header
// ──────────────────────────────────────────────────────────────────────

interface CanvasHeaderProps {
  locale: EditorLocale;
  isPrimary: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

function CanvasHeader({
  locale,
  isPrimary,
  saving,
  onSave,
  onDiscard,
}: CanvasHeaderProps): JSX.Element {
  const meta = localeMeta(locale.locale);
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--stroke-soft)] pb-2">
      <div className="flex items-center gap-2">
        <span
          className="font-display text-[18px] leading-none tracking-[-0.005em] text-[var(--ink-primary)]"
          style={{ fontVariationSettings: "'wght' 600" }}
        >
          {meta.flag} {meta.name}
        </span>
        {isPrimary && <Stamp>Primary</Stamp>}
        {locale.dirty && <Stamp variant="warning">Pending Push</Stamp>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={!locale.dirty}>
          <RotateCcw size={12} /> Discard
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={!locale.dirty || saving}>
          {saving ? <Spinner size={12} /> : <Save size={12} />}
          Save locally
        </Button>
      </div>
    </header>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Field row + inline AI drawer
// ──────────────────────────────────────────────────────────────────────

interface FieldRowProps {
  field: FieldDef;
  locale: EditorLocale;
  platform: Platform;
  pack: FieldGenerateResponse | null;
  drawerOpen: boolean;
  generating: boolean;
  onChange: (value: string | null) => void;
  onGenerate: () => void;
  onToggleDrawer: () => void;
}

function FieldRow({
  field,
  locale,
  platform,
  pack,
  drawerOpen,
  generating,
  onChange,
  onGenerate,
  onToggleDrawer,
}: FieldRowProps): JSX.Element {
  const raw = (locale[field.field] as string | null) ?? "";
  const count = charCount(raw);
  const id = `field-${field.field as string}-${locale.locale}`;
  const overBudget = count > field.max;
  const hasAi = field.aiKind !== undefined;

  return (
    <div className="rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2 pb-1">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={id} className="text-[12px] font-medium">
            {field.label}
          </Label>
          <FieldHint field={field.field} platform={platform} />
          {pack && (
            <StrengthChip
              strength={pack.result.current.strength}
              score={pack.result.current.score}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              // Three-stage gradient so the operator gets a peripheral
              // warning before the limit hits: tertiary ink until 80%,
              // warning amber 80-100%, danger red over.
              overBudget
                ? "font-semibold text-[var(--status-danger)]"
                : field.max > 0 && count / field.max >= 0.8
                  ? "font-semibold text-[var(--status-warning)]"
                  : "text-[var(--ink-tertiary)]",
            )}
          >
            {count.toString()} / {field.max.toString()}
          </span>
          {hasAi && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!pack) onGenerate();
                else onToggleDrawer();
              }}
              disabled={generating}
              title={
                pack
                  ? drawerOpen
                    ? "Hide alternatives"
                    : "Show alternatives"
                  : "Generate AI alternatives"
              }
            >
              {generating ? (
                <Spinner size={12} />
              ) : pack ? (
                <Sparkles size={12} />
              ) : (
                <Wand2 size={12} />
              )}
              {generating
                ? "Generating…"
                : pack
                  ? `${pack.result.alternatives.length.toString()} alts`
                  : "Generate"}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5 px-3 pb-3">
        {field.type === "textarea" ? (
          <Textarea
            id={id}
            rows={field.rows ?? 3}
            value={raw}
            onChange={(e) => onChange(e.target.value || null)}
            aria-invalid={overBudget}
            className="mt-0 resize-y"
            lang={locale.locale}
          />
        ) : (
          <Input
            id={id}
            type={field.type === "url" ? "url" : "text"}
            value={raw}
            onChange={(e) => onChange(e.target.value || null)}
            className={cn(
              "mt-0",
              overBudget &&
                "border-[var(--status-danger)] focus:border-[var(--status-danger)] focus:ring-[var(--status-danger)]",
            )}
            lang={locale.locale}
          />
        )}
        {/* Char counter in the field header (top-right) is the only
         *  numeric readout — the duplicate CharLimitBar progress + text
         *  here got pruned because the header counter colours itself
         *  (white → warning → danger) as the operator types, which
         *  covers the same job in less space. */}
      </div>

      {/* Inline AI drawer — opens under the input so the operator sees
       *  alternatives in context, without losing the field they were
       *  editing. */}
      {hasAi && drawerOpen && pack && (
        <div className="border-t border-[var(--stroke-soft)] bg-[var(--surface-sunken)] px-3 py-3">
          <AiVariantsDrawer
            field={field}
            pack={pack.result}
            provider={pack.provider}
            currentRaw={raw}
            onRegenerate={onGenerate}
            generating={generating}
            onApply={(text) => {
              onChange(text);
              onToggleDrawer();
              toast.success(`Applied — ${field.label} updated. Save locally to keep.`);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// LinksCard — compact group of URL inputs (Marketing URL / Support URL /
// Privacy Policy URL / video URL). Three separate field cards used to
// take up half the canvas; this single card collapses them into one
// stack with inline labels + per-row character counters. Privacy URL
// is marked with a subtle red asterisk because both stores reject
// submissions without one. URL rows skip the FieldHint lightbulb —
// the label itself is unambiguous ("Marketing URL" means what it
// says), the hint registry mostly described what these are for, which
// is self-evident.
// ──────────────────────────────────────────────────────────────────────

interface LinksCardProps {
  fields: FieldDef[];
  locale: EditorLocale;
  onChange: (field: keyof EditorLocale, value: string | null) => void;
}

function LinksCard({ fields, locale, onChange }: LinksCardProps): JSX.Element {
  // No card header — the URL rows are self-describing via their labels,
  // and the surrounding canvas already grounds them as part of the
  // locale's metadata. A "Links" title would just be a 12px word
  // floating above four rows that announce themselves.
  return (
    <div className="rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
      <div className="divide-y divide-[var(--stroke-soft)]">
        {fields.map((f) => (
          <LinkRow
            key={f.field as string}
            field={f}
            locale={locale}
            onChange={(value) => onChange(f.field, value)}
          />
        ))}
      </div>
    </div>
  );
}

function LinkRow({
  field,
  locale,
  onChange,
}: {
  field: FieldDef;
  locale: EditorLocale;
  onChange: (value: string | null) => void;
}): JSX.Element {
  const raw = (locale[field.field] as string | null) ?? "";
  const count = charCount(raw);
  const id = `field-${field.field as string}-${locale.locale}`;
  const overBudget = count > field.max;
  const isRequired = field.field === "privacyPolicyUrl";
  // Privacy field's label varies across the codebase ("Privacy policy
  // URL"); normalize the casing here so the row always reads
  // "Privacy Policy URL" — title-case is what both stores' own forms
  // use and matches the other two URL labels.
  const label = field.field === "privacyPolicyUrl" ? "Privacy Policy URL" : field.label;

  // 170px label column fits "Privacy Policy URL" + asterisk on one
  // line with margin. The narrower 120/150 px tried earlier wrapped on
  // longer strings.
  return (
    <div className="grid grid-cols-[170px_1fr_auto] items-center gap-3 px-3 py-2">
      <Label htmlFor={id} className="text-[12px] font-medium">
        {label}
        {/* Minimal required marker — a single red asterisk inline with
         *  the label, the universal form-field convention. The old
         *  tinted "Required" pill drew the eye off the input itself. */}
        {isRequired && (
          <span
            aria-label="Required"
            title="Required by both stores"
            className="ml-0.5 text-[var(--status-danger)]"
          >
            *
          </span>
        )}
      </Label>
      <Input
        id={id}
        type="url"
        value={raw}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="https://"
        className={cn(
          "mt-0 h-9 text-[12.5px]",
          overBudget &&
            "border-[var(--status-danger)] focus:border-[var(--status-danger)] focus:ring-[var(--status-danger)]",
        )}
        lang={locale.locale}
      />
      {count > 0 && (
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] tabular-nums",
            overBudget
              ? "font-semibold text-[var(--status-danger)]"
              : count / field.max >= 0.9
                ? "text-[var(--status-warning)]"
                : "text-[var(--ink-tertiary)]",
          )}
        >
          {count}/{field.max}
        </span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Empty state
// ──────────────────────────────────────────────────────────────────────

function EmptyCanvas(): JSX.Element {
  return (
    <Card className="border-dashed">
      <p className="text-[13px] text-[var(--ink-secondary)]">
        No locale selected. Choose a language on the left, or use <strong>Pull from store</strong>{" "}
        in the app header to seed metadata.
      </p>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function capitaliseLabel(kind: FieldKind): string {
  if (kind === "title") return "Title";
  if (kind === "subtitle") return "Subtitle";
  if (kind === "keywords") return "Keywords";
  if (kind === "promo") return "Promo";
  return "Description";
}

// Re-export the editor locale type so callers (route pages) can import
// from this single module.
export type { EditorLocale } from "./MetadataEditor";
