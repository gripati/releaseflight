"use client";

/**
 * Legacy MetadataEditor module — now a shared-helpers file.
 *
 * The 1479-LOC monolithic MetadataEditor component that this file used
 * to export was retired in the Phase 2 UX refactor. The new editing
 * surface lives in `StudioEditor.tsx` (three-column workspace with a
 * collapsible inspector). This file is kept as the home for the
 * reusable pieces that both editors share: field definitions, strength
 * + verdict styling, AI variants drawer, keyword chip rendering,
 * tokenisation helpers.
 *
 * Phase 5 cleanup: deleted ~500 LOC of the legacy component + its
 * FieldCard helper. Phase 6 (future) may split this into purpose-named
 * files (`StudioConfig.ts`, `AiVariantsDrawer.tsx`,
 * `KeywordsFieldChips.tsx`) but the consolidated form is fine as long
 * as it stays a "library of small things" rather than a kitchen sink.
 */
import { useMemo, useState } from "react";
import { Sparkles, Check, Wand2, AlertCircle, X } from "lucide-react";
import { Button, Spinner, cn } from "@marquee/ui";
import { validateKeywordsField, type KeywordWarning } from "@marquee/aso";

// ──────────────────────────────────────────────────────────────────────
// Shared types — imported by StudioEditor + any future editor surface
// ──────────────────────────────────────────────────────────────────────

export interface EditorLocale {
  id: string;
  locale: string;
  name: string | null;
  subtitle: string | null;
  description: string | null;
  keywords: string | null;
  whatsNew: string | null;
  promotionalText: string | null;
  marketingUrl: string | null;
  supportUrl: string | null;
  privacyPolicyUrl: string | null;
  shortDescription: string | null;
  videoUrl: string | null;
  dirty: boolean;
  /** Storefront the locale maps to (drives keyword chip quick-add). */
  territory: string;
}

export type FieldKind = "title" | "subtitle" | "keywords" | "promo" | "description";
export type Strength = "WEAK" | "FAIR" | "GOOD" | "STRONG" | "EXCEPTIONAL";
export type Verdict = "REPLACE_NOW" | "WORTH_AB_TESTING" | "MARGINAL_GAIN" | "KEEP_CURRENT";

/** Tracked keyword shape consumed by KeywordsFieldChips. Mirrors the
 *  same fields StudioEditor passes through, so both editors agree. */
export interface TrackedKeyword {
  id: string;
  keyword: string;
  score: number | null;
  bucket: string | null;
  rank: number | null;
}

export interface FieldAlternative {
  text: string;
  score: number;
  strength: Strength;
  verdict: Verdict;
  plainReason: string;
  organicLift: string;
  improvements: string[];
}

export interface CurrentAssessment {
  score: number;
  strength: Strength;
  summary: string;
  weaknesses: string[];
}

export interface FieldVariantsResult {
  current: CurrentAssessment;
  alternatives: FieldAlternative[];
  notes?: string | null;
}

export interface FieldGenerateResponse {
  field: FieldKind;
  locale: string;
  result: FieldVariantsResult;
  provider: string;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; usdCost: number };
}

// Per-field cache keyed by `${locale}::${fieldKind}`.
export type FieldPackKey = string;
export const packKey = (locale: string, kind: FieldKind): FieldPackKey => `${locale}::${kind}`;

// ──────────────────────────────────────────────────────────────────────
// Field config
// ──────────────────────────────────────────────────────────────────────

export interface FieldDef {
  /** Database column on EditorLocale */
  field: keyof EditorLocale;
  label: string;
  max: number;
  type: "text" | "textarea" | "url" | "keywords";
  rows?: number;
  /** Plain-language hint shown under the input. */
  help: string;
  /** When set, enables the AI Generate button + maps to the prompt kind. */
  aiKind?: FieldKind;
}

export const FIELDS_IOS: FieldDef[] = [
  {
    field: "name",
    label: "Title",
    max: 30,
    type: "text",
    aiKind: "title",
    help: "First 23 chars show in search rows — front-load the unique brand noun.",
  },
  {
    field: "subtitle",
    label: "Subtitle",
    max: 30,
    type: "text",
    aiKind: "subtitle",
    help: "iOS only. Indexed at the SAME weight as the keywords field — never echo the title.",
  },
  {
    field: "keywords",
    label: "Keywords field",
    max: 100,
    type: "keywords",
    aiKind: "keywords",
    help: "iOS only. Comma-separated, no spaces. Avoid duplicating words in title or subtitle.",
  },
  {
    field: "promotionalText",
    label: "Promotional text",
    max: 170,
    type: "textarea",
    rows: 3,
    aiKind: "promo",
    help: "iOS only. NOT indexed for search — pure conversion lever. Updates instantly without App Review.",
  },
  {
    field: "description",
    label: "Description",
    max: 4000,
    type: "textarea",
    rows: 14,
    aiKind: "description",
    help: "First 3 lines are above the fold. Google Play indexes the full description; Apple barely does.",
  },
  {
    field: "whatsNew",
    label: "What's new",
    max: 4000,
    type: "textarea",
    rows: 5,
    help: "Optional per-version release notes.",
  },
  { field: "marketingUrl", label: "Marketing URL", max: 255, type: "url", help: "Optional." },
  { field: "supportUrl", label: "Support URL", max: 255, type: "url", help: "Optional." },
  {
    field: "privacyPolicyUrl",
    label: "Privacy policy URL",
    max: 255,
    type: "url",
    help: "Required by both stores.",
  },
];

export const FIELDS_ANDROID: FieldDef[] = [
  {
    field: "name",
    label: "Title",
    max: 50,
    type: "text",
    aiKind: "title",
    help: "Google Play indexes the title heavily. Front-load the strongest keyword theme.",
  },
  {
    field: "shortDescription",
    label: "Short description",
    max: 80,
    type: "textarea",
    rows: 3,
    help: "Shown above the fold on the listing — sells the install before the user taps 'more'.",
  },
  {
    field: "description",
    label: "Full description",
    max: 4000,
    type: "textarea",
    rows: 14,
    aiKind: "description",
    help: "Google Play indexes the full description with keyword-density signals — write for both humans and search.",
  },
  {
    field: "videoUrl",
    label: "YouTube video",
    max: 255,
    type: "url",
    help: "Optional but boosts conversion.",
  },
];

export function charCount(value: string | null): number {
  return value ? [...value].length : 0;
}

// ──────────────────────────────────────────────────────────────────────
// Strength + verdict styling
// ──────────────────────────────────────────────────────────────────────

export const STRENGTH_META: Record<
  Strength,
  { label: string; tone: string; bg: string; fg: string; border: string; bar: string }
> = {
  WEAK: {
    label: "Weak",
    tone: "Replace urgently",
    bg: "rgba(229, 62, 62, 0.08)",
    fg: "var(--status-danger)",
    border: "var(--status-danger)",
    bar: "var(--status-danger)",
  },
  FAIR: {
    label: "Fair",
    tone: "Could improve",
    bg: "rgba(237, 137, 54, 0.10)",
    fg: "#C05621",
    border: "#ED8936",
    bar: "#ED8936",
  },
  GOOD: {
    label: "Good",
    tone: "Solid baseline",
    bg: "rgba(214, 158, 46, 0.10)",
    fg: "#975A16",
    border: "#D69E2E",
    bar: "#D69E2E",
  },
  STRONG: {
    label: "Strong",
    tone: "High-performing",
    bg: "rgba(56, 161, 105, 0.10)",
    fg: "#276749",
    border: "#38A169",
    bar: "#38A169",
  },
  EXCEPTIONAL: {
    label: "Exceptional",
    tone: "Best-in-class",
    bg: "rgba(102, 51, 238, 0.10)",
    fg: "#553C9A",
    border: "#6633EE",
    bar: "#6633EE",
  },
};

export const VERDICT_META: Record<
  Verdict,
  { label: string; tone: string; fg: string; bg: string; border: string; primary: boolean }
> = {
  REPLACE_NOW: {
    label: "Replace now",
    tone: "Materially stronger",
    fg: "#FFFFFF",
    bg: "var(--signal)",
    border: "var(--signal)",
    primary: true,
  },
  WORTH_AB_TESTING: {
    label: "Worth A/B",
    tone: "Different angle, similar score",
    fg: "#2C5282",
    bg: "rgba(66, 153, 225, 0.12)",
    border: "#4299E1",
    primary: false,
  },
  MARGINAL_GAIN: {
    label: "Marginal gain",
    tone: "Small lift",
    fg: "#975A16",
    bg: "rgba(214, 158, 46, 0.10)",
    border: "#D69E2E",
    primary: false,
  },
  KEEP_CURRENT: {
    label: "Keep current",
    tone: "Current copy wins",
    fg: "var(--ink-tertiary)",
    bg: "var(--surface-tinted)",
    border: "var(--stroke-default)",
    primary: false,
  },
};

// Strength chip
// ──────────────────────────────────────────────────────────────────────

export function StrengthChip({
  strength,
  score,
}: {
  strength: Strength;
  score: number;
}): JSX.Element {
  const m = STRENGTH_META[strength];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase"
      style={{ background: m.bg, color: m.fg, border: `0.5px solid ${m.border}` }}
      title={m.tone}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.bar }} />
      {m.label} · {score.toString()}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict }): JSX.Element {
  const m = VERDICT_META[verdict];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase"
      style={{ background: m.bg, color: m.fg, border: `0.5px solid ${m.border}` }}
      title={m.tone}
    >
      {m.label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// AI variants drawer
// ──────────────────────────────────────────────────────────────────────

export function AiVariantsDrawer({
  field,
  pack,
  provider,
  currentRaw,
  generating,
  onRegenerate,
  onApply,
}: {
  field: FieldDef;
  pack: FieldVariantsResult;
  provider: string | undefined;
  currentRaw: string;
  generating: boolean;
  onRegenerate: () => void;
  onApply: (text: string) => void;
}): JSX.Element {
  const current = pack.current;
  const ranked = [...pack.alternatives].sort((a, b) => b.score - a.score);
  const replaceCandidates = ranked.filter((a) => a.verdict === "REPLACE_NOW").length;

  return (
    <div className="mt-3 space-y-4 rounded-[var(--radius)] border-[0.5px] border-[var(--signal)]/60 bg-[var(--surface-elevated)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
            AI alternatives · {field.label.toLowerCase()}
          </p>
          <p className="font-body mt-0.5 text-[12px] text-[var(--ink-secondary)]">
            {ranked.length.toString()} option{ranked.length === 1 ? "" : "s"} ·{" "}
            {replaceCandidates > 0
              ? `${replaceCandidates.toString()} marked Replace now`
              : "no clear winners — current looks OK"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {provider && (
            <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">{provider}</span>
          )}
          <Button variant="ghost" size="sm" onClick={onRegenerate} disabled={generating}>
            {generating ? <Spinner size={12} /> : <Wand2 size={12} />}
            Regenerate
          </Button>
        </div>
      </div>

      {/* Current copy assessment */}
      <CurrentAssessmentBlock current={current} currentRaw={currentRaw} field={field} />

      {/* Alternatives */}
      <ol className="space-y-3">
        {ranked.map((alt, i) => (
          <AlternativeCard
            key={`${field.field as string}-${i.toString()}`}
            rank={i + 1}
            alt={alt}
            current={current}
            fieldMax={field.max}
            isCurrent={alt.text === currentRaw}
            onApply={() => onApply(alt.text)}
          />
        ))}
      </ol>

      {pack.notes && (
        <p className="font-body rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-paper)] px-3 py-2 text-[12px] text-[var(--ink-secondary)]">
          <span className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Note ·{" "}
          </span>
          {pack.notes}
        </p>
      )}
    </div>
  );
}

function CurrentAssessmentBlock({
  current,
  currentRaw,
  field,
}: {
  current: CurrentAssessment;
  currentRaw: string;
  field: FieldDef;
}): JSX.Element {
  const m = STRENGTH_META[current.strength];
  return (
    <div
      className="rounded-[var(--radius)] border-[0.5px] p-3"
      style={{ background: m.bg, borderColor: m.border }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] tracking-[0.10em] text-[var(--ink-tertiary)] uppercase">
          Current
        </span>
        <StrengthChip strength={current.strength} score={current.score} />
      </div>
      <p
        className="font-display mt-2 text-[15px] leading-[1.4] break-words"
        style={{ fontVariationSettings: "'wght' 500" }}
      >
        {currentRaw.trim().length === 0 ? (
          <span className="text-[var(--ink-tertiary)] italic">— empty —</span>
        ) : field.type === "textarea" ? (
          <span className="line-clamp-4 whitespace-pre-wrap">{currentRaw}</span>
        ) : (
          <>"{currentRaw}"</>
        )}
      </p>
      <p className="font-body mt-2 text-[12px] leading-[1.55] text-[var(--ink-secondary)]">
        {current.summary}
      </p>
      {current.weaknesses.length > 0 && (
        <ul className="mt-2 space-y-1">
          {current.weaknesses.map((w, i) => (
            <li
              key={i}
              className="font-body flex items-start gap-1.5 text-[12px] text-[var(--ink-secondary)]"
            >
              <AlertCircle size={11} className="mt-[3px] flex-shrink-0" style={{ color: m.bar }} />
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlternativeCard({
  rank,
  alt,
  current,
  fieldMax,
  isCurrent,
  onApply,
}: {
  rank: number;
  alt: FieldAlternative;
  current: CurrentAssessment;
  fieldMax: number;
  isCurrent: boolean;
  onApply: () => void;
}): JSX.Element {
  const m = STRENGTH_META[alt.strength];
  const v = VERDICT_META[alt.verdict];
  const delta = alt.score - current.score;
  const overBudget = alt.text.length > fieldMax;
  const isTop = rank === 1;

  return (
    <li
      className={cn(
        "rounded-[var(--radius)] border-[0.5px] bg-[var(--surface-paper)] p-3.5 transition-all",
        isCurrent
          ? "border-[var(--status-success)] bg-[var(--status-success-tint)]"
          : v.primary && !overBudget
            ? "border-[var(--signal)] shadow-[var(--shadow-hairline)]"
            : "border-[var(--stroke-default)] hover:border-[var(--signal)]/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] font-medium tabular-nums"
              style={{
                background: isTop ? m.border : "var(--surface-tinted)",
                color: isTop ? "#FFFFFF" : "var(--ink-secondary)",
              }}
            >
              {rank.toString()}
            </span>
            <StrengthChip strength={alt.strength} score={alt.score} />
            <VerdictChip verdict={alt.verdict} />
            {delta !== 0 && (
              <span
                className="font-mono text-[10px] tabular-nums"
                style={{ color: delta > 0 ? "var(--status-success)" : "var(--status-danger)" }}
                title="Score delta vs current"
              >
                {delta > 0 ? "+" : ""}
                {delta.toString()} vs current
              </span>
            )}
            <span
              className={cn(
                "ml-auto font-mono text-[10px] tabular-nums",
                overBudget ? "text-[var(--status-danger)]" : "text-[var(--ink-tertiary)]",
              )}
            >
              {alt.text.length.toString()} / {fieldMax.toString()}
            </span>
          </div>

          <p
            className="font-display text-[16px] leading-[1.4] tracking-[-0.005em] break-words"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            {fieldMax > 200 ? (
              <span className="line-clamp-6 whitespace-pre-wrap">{alt.text}</span>
            ) : (
              <>"{alt.text}"</>
            )}
          </p>

          <p className="font-body text-[12px] leading-[1.55] text-[var(--ink-secondary)]">
            {alt.plainReason}
          </p>

          <div className="rounded-[var(--radius-xs)] border-[0.5px] border-dashed border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5">
            <p className="font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              Expected organic lift
            </p>
            <p className="font-body mt-0.5 text-[12px] text-[var(--ink-secondary)]">
              {alt.organicLift}
            </p>
          </div>

          {alt.improvements.length > 0 && (
            <ul className="space-y-1">
              {alt.improvements.map((imp, i) => (
                <li
                  key={i}
                  className="font-body flex items-start gap-1.5 text-[12px] text-[var(--ink-secondary)]"
                >
                  <Check
                    size={11}
                    className="mt-[3px] flex-shrink-0 text-[var(--status-success)]"
                  />
                  {imp}
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button
          variant={v.primary && !overBudget && !isCurrent ? "primary" : "secondary"}
          size="sm"
          disabled={isCurrent || overBudget}
          onClick={onApply}
        >
          {isCurrent ? <Check size={12} /> : <Sparkles size={12} />}{" "}
          {isCurrent ? "Active" : "Apply"}
        </Button>
      </div>
    </li>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Keywords chip editor — score-aware. Every chip in the field is
// cross-referenced against the tenant's TrackedKeyword signals, so
// the user can see at a glance which keywords are pulling weight,
// which are decaying, and which untracked candidates are stronger.
// ──────────────────────────────────────────────────────────────────────

type Bucket = "CHAMPION" | "OPPORTUNITY" | "RISING" | "DECAY" | "NEUTRAL" | "UNKNOWN";

const BUCKET_META: Record<
  Bucket,
  { label: string; dot: string; bg: string; border: string; fg: string; rank: number }
> = {
  CHAMPION: {
    label: "Champion",
    dot: "#6633EE",
    bg: "rgba(102, 51, 238, 0.10)",
    border: "#6633EE",
    fg: "#553C9A",
    rank: 5,
  },
  OPPORTUNITY: {
    label: "Opportunity",
    dot: "#38A169",
    bg: "rgba(56, 161, 105, 0.10)",
    border: "#38A169",
    fg: "#276749",
    rank: 4,
  },
  RISING: {
    label: "Rising",
    dot: "#0EA5E9",
    bg: "rgba(14, 165, 233, 0.10)",
    border: "#0EA5E9",
    fg: "#075985",
    rank: 3,
  },
  NEUTRAL: {
    label: "Neutral",
    dot: "var(--ink-tertiary)",
    bg: "var(--surface-tinted)",
    border: "var(--stroke-default)",
    fg: "var(--ink-secondary)",
    rank: 2,
  },
  DECAY: {
    label: "Decay",
    dot: "var(--status-danger)",
    bg: "rgba(229, 62, 62, 0.08)",
    border: "var(--status-danger)",
    fg: "var(--status-danger)",
    rank: 1,
  },
  UNKNOWN: {
    label: "Untracked",
    dot: "var(--ink-tertiary)",
    bg: "var(--surface-paper)",
    border: "var(--stroke-default)",
    fg: "var(--ink-tertiary)",
    rank: 0,
  },
};

function resolveBucket(raw: string | null | undefined): Bucket {
  if (!raw) return "UNKNOWN";
  if (
    raw === "CHAMPION" ||
    raw === "OPPORTUNITY" ||
    raw === "RISING" ||
    raw === "DECAY" ||
    raw === "NEUTRAL"
  ) {
    return raw;
  }
  return "UNKNOWN";
}

interface ChipMeta {
  text: string;
  tracked: TrackedKeyword | null;
  bucket: Bucket;
  score: number | null;
  rank: number | null;
}

function buildChipMeta(token: string, trackedByLower: Map<string, TrackedKeyword>): ChipMeta {
  const t = trackedByLower.get(token.toLowerCase()) ?? null;
  return {
    text: token,
    tracked: t,
    bucket: resolveBucket(t?.bucket),
    score: t?.score ?? null,
    rank: t?.rank ?? null,
  };
}

/** Payload passed to {@link KeywordsFieldChipsProps.onInspect} when
 *  the operator clicks a chip. Bundles the tracked-keyword record with
 *  the Apple-rules warnings the validator attached to the same token,
 *  plus the chip's DOM element so an anchored popover can position
 *  itself relative to the clicked chip. */
export interface ChipInspectPayload {
  trackedKeyword: TrackedKeyword;
  warnings: KeywordWarning[];
  /** The chip's button element — feeds an anchored popover's
   *  `getBoundingClientRect()` positioning + outside-click detection. */
  anchor: HTMLElement;
}

export function KeywordsFieldChips({
  value,
  onChange,
  maxChars,
  tracked,
  onInspect,
  appName,
  title,
  subtitle,
}: {
  value: string;
  onChange: (next: string) => void;
  maxChars: number;
  tracked: TrackedKeyword[];
  /** Callback when the user clicks a chip to open the research dossier.
   *  Receives the tracked-keyword record + any field-rule warnings the
   *  validator attached to the same token, so the consumer can render
   *  both Astro detail AND warnings inside the popover. */
  onInspect?: (payload: ChipInspectPayload) => void;
  /** App name — checked for overlap (Apple indexes it heavily). */
  appName?: string;
  /** Locale title — checked for overlap (Apple auto-indexes). */
  title?: string | null;
  /** Locale subtitle — checked for overlap (Apple auto-indexes). */
  subtitle?: string | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const tokens = useMemo(() => parseTokens(value), [value]);
  const joined = tokens.join(",");
  const overBudget = joined.length > maxChars;

  const trackedByLower = useMemo(() => {
    const m = new Map<string, TrackedKeyword>();
    for (const t of tracked) m.set(t.keyword.toLowerCase(), t);
    return m;
  }, [tracked]);

  // Run the Apple-rules validator over the current field. Returns per-
  // token warnings + an aggregate "chars could be freed" total. Pure
  // function from @marquee/aso so the UI just renders what it gets.
  const fieldValidation = useMemo(
    () =>
      validateKeywordsField(joined, {
        appName: appName ?? null,
        title: title ?? null,
        subtitle: subtitle ?? null,
      }),
    [joined, appName, title, subtitle],
  );
  const warningsByToken = useMemo(() => {
    const m = new Map<string, KeywordWarning[]>();
    for (const t of fieldValidation.tokens) {
      m.set(t.token.toLowerCase(), t.warnings);
    }
    return m;
  }, [fieldValidation]);

  const chips = useMemo<ChipMeta[]>(
    () => tokens.map((tok) => buildChipMeta(tok, trackedByLower)),
    [tokens, trackedByLower],
  );

  function add(raw: string): void {
    const t = raw.trim();
    if (t.length === 0 || t.length > 80) return;
    if (tokens.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange([...tokens, t].join(","));
    setInput("");
  }

  function remove(idx: number): void {
    const next = tokens.filter((_, i) => i !== idx);
    onChange(next.join(","));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(input);
    } else if (e.key === "Backspace" && input.length === 0 && tokens.length > 0) {
      onChange(tokens.slice(0, -1).join(","));
    }
  }

  // Note: the previous in-card "Swap suggestions" + "Tracked candidates
  // not yet in field" logic was retired. Recommendations now come from
  // a single canonical source: the Astro panel rendered as a sibling
  // section below the field card. This card stays focused on the field
  // itself: the chips the user is editing + Apple-rule validation.

  const untrackedChipsCount = chips.filter((c) => c.tracked === null).length;

  return (
    <div className="mt-0 space-y-2.5">
      <div
        className={cn(
          "flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border-[0.5px] bg-[var(--surface-elevated)] px-2 py-1.5",
          overBudget ? "border-[var(--status-danger)]" : "border-[var(--stroke-input)]",
        )}
      >
        {chips.map((c, i) => {
          const chipWarnings = warningsByToken.get(c.text.toLowerCase()) ?? [];
          return (
            <ChipPill
              key={`${c.text}-${i.toString()}`}
              meta={c}
              onRemove={() => remove(i)}
              warnings={chipWarnings}
              {...(c.tracked && onInspect
                ? {
                    onInspect: (anchor: HTMLElement) =>
                      onInspect({
                        trackedKeyword: c.tracked!,
                        warnings: chipWarnings,
                        anchor,
                      }),
                  }
                : {})}
            />
          );
        })}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={chips.length === 0 ? "Type a keyword, press Enter or comma…" : "+ keyword"}
          className="min-w-[140px] flex-1 bg-transparent font-mono text-[12px] focus:outline-none"
          maxLength={80}
        />
      </div>

      <ChipLegend untrackedCount={untrackedChipsCount} />

      {fieldValidation.totalCharsSaved > 0 && (
        <KeywordsFieldValidationSummary
          totalCharsSaved={fieldValidation.totalCharsSaved}
          worstSeverity={fieldValidation.worstSeverity}
          warningCount={fieldValidation.tokens.reduce((n, t) => n + t.warnings.length, 0)}
        />
      )}

      {/* NOTE: keyword RECOMMENDATIONS live in the unified Astro panel
          rendered as a sibling section right below this card (see
          AstroProposalsForLocale in MetadataEditor's render tree).
          The earlier "Swap suggestions" + "Tracked candidates not yet
          in field" blocks were stripped from here — they showed a
          local heuristic that competed with Astro's better-ranked
          output. One source of truth, less cognitive overhead. */}
    </div>
  );
}

function ChipPill({
  meta,
  onRemove,
  onInspect,
  muted,
  readOnly,
  warnings,
}: {
  meta: ChipMeta;
  onRemove?: () => void;
  /** When set, the chip body becomes a button that opens the keyword
   *  research dossier. Only available for tracked chips — untracked
   *  words have no signals to inspect.
   *
   *  The callback receives the chip's clicked button element so an
   *  anchored popover can position itself relative to the chip. */
  onInspect?: (anchor: HTMLElement) => void;
  muted?: boolean;
  readOnly?: boolean;
  /** Apple-rules validation warnings attached to this token. When
   *  non-empty, a coloured dot is rendered next to the chip; the
   *  worst-severity warning sets the dot colour. Hover shows full
   *  detail (combined warning messages). */
  warnings?: KeywordWarning[];
}): JSX.Element {
  const m = BUCKET_META[meta.bucket];
  const canInspect = onInspect !== undefined && meta.tracked !== null;
  const worstWarning =
    (warnings ?? []).find((w) => w.severity === "danger") ??
    (warnings ?? []).find((w) => w.severity === "warning") ??
    (warnings ?? []).find((w) => w.severity === "info") ??
    null;
  const warningDotColor = worstWarning
    ? worstWarning.severity === "danger"
      ? "var(--status-danger)"
      : worstWarning.severity === "warning"
        ? "var(--status-warning)"
        : "var(--status-info)"
    : null;
  const titleParts: string[] = [];
  if (meta.tracked) {
    titleParts.push(m.label);
    if (meta.score !== null) titleParts.push(`score ${meta.score.toFixed(2)}`);
    if (meta.rank) titleParts.push(`rank ${meta.rank.toString()}`);
  } else {
    titleParts.push("Not tracked yet — sync to score it");
  }
  if (canInspect) titleParts.push("click to inspect");
  if (warnings && warnings.length > 0) {
    titleParts.push("");
    titleParts.push(
      `⚠ ${warnings.length.toString()} keyword-field warning${warnings.length === 1 ? "" : "s"}:`,
    );
    for (const w of warnings) titleParts.push(`  • ${w.message}`);
  }
  const titleText = titleParts.join("\n");
  const inner = (
    <>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.dot }} />
      <span>{meta.text}</span>
      {meta.score !== null && (
        <span className="tabular-nums opacity-80">{meta.score.toFixed(2)}</span>
      )}
      {warningDotColor && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: warningDotColor }}
          aria-label={`${(warnings ?? []).length.toString()} validation warning${(warnings ?? []).length === 1 ? "" : "s"}`}
        />
      )}
    </>
  );
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border-[0.5px] px-1.5 py-0.5 font-mono text-[11px]"
      style={{
        borderColor: m.border,
        background: muted ? "var(--surface-sunken)" : m.bg,
        color: muted ? "var(--ink-tertiary)" : m.fg,
        opacity: muted ? 0.85 : 1,
      }}
      title={titleText}
    >
      {canInspect ? (
        <button
          type="button"
          // Hand the popover the chip's element so it can anchor +
          // position relative to the clicked chip. We bubble the
          // event's currentTarget (the button element) so the
          // popover can do its own getBoundingClientRect math.
          onClick={(e) => onInspect(e.currentTarget)}
          className="inline-flex items-center gap-1.5 hover:underline focus:outline-none focus-visible:underline"
        >
          {inner}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">{inner}</span>
      )}
      {!readOnly && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${meta.text}`}
          className="hover:text-[var(--status-danger)]"
        >
          <X size={9} />
        </button>
      )}
    </span>
  );
}

function ChipLegend({ untrackedCount }: { untrackedCount: number }): JSX.Element {
  const items: { bucket: Bucket; hint: string }[] = [
    { bucket: "CHAMPION", hint: "score ≥ 0.75" },
    { bucket: "OPPORTUNITY", hint: "0.50-0.75" },
    { bucket: "RISING", hint: "trending up" },
    { bucket: "NEUTRAL", hint: "weak signal" },
    { bucket: "DECAY", hint: "lost ranking" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--ink-tertiary)]">
      {items.map((it) => {
        const m = BUCKET_META[it.bucket];
        return (
          <span key={it.bucket} className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.dot }} />
            <span style={{ color: m.fg }}>{m.label}</span>
            <span className="opacity-70">· {it.hint}</span>
          </span>
        );
      })}
      {untrackedCount > 0 && (
        <span className="inline-flex items-center gap-1 text-[var(--ink-tertiary)]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ink-tertiary)]/40" />
          {untrackedCount.toString()} untracked · run sync to score
        </span>
      )}
    </div>
  );
}

/**
 * Apple-rules validation summary for the keywords field. Surfaces the
 * aggregate "X chars could be freed" across all detected warnings + a
 * coloured banner sized by worst severity:
 *
 *   danger  → red banner (legal risk: trademark / over-length).
 *   warning → amber banner (waste: overlap / plural dup / stop word).
 *   info    → blue banner (advice only: special chars / digits).
 *
 * Hides itself entirely when totalCharsSaved === 0 (clean field). The
 * per-chip warning dots provide the granular detail; this banner is
 * the at-a-glance summary.
 */
function KeywordsFieldValidationSummary({
  totalCharsSaved,
  worstSeverity,
  warningCount,
}: {
  totalCharsSaved: number;
  worstSeverity: "info" | "warning" | "danger" | null;
  warningCount: number;
}): JSX.Element | null {
  if (worstSeverity == null || warningCount === 0) return null;
  const tone =
    worstSeverity === "danger"
      ? {
          bg: "var(--status-danger-tint)",
          border: "var(--status-danger)",
          fg: "var(--status-danger)",
          label: "Action needed",
        }
      : worstSeverity === "warning"
        ? {
            bg: "rgba(214, 158, 46, 0.10)",
            border: "var(--status-warning)",
            fg: "#975A16",
            label: "Wasted characters",
          }
        : {
            bg: "var(--status-info-tint)",
            border: "var(--status-info)",
            fg: "var(--status-info)",
            label: "Optimization tip",
          };
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-[var(--radius-xs)] border-[0.5px] px-2 py-1 font-mono text-[10px] tracking-[0.06em] uppercase"
      style={{
        borderColor: tone.border,
        background: tone.bg,
        color: tone.fg,
      }}
      role="status"
    >
      <span className="font-medium">{tone.label}</span>
      <span className="opacity-80">
        {warningCount.toString()} warning{warningCount === 1 ? "" : "s"}
      </span>
      {totalCharsSaved > 0 && (
        <span className="ml-auto opacity-90">
          {totalCharsSaved.toString()} chars could be freed
        </span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Small utilities — used across the editor.
// ──────────────────────────────────────────────────────────────────────

/** Tokenise an iOS keywords field. Apple counts characters including
 *  commas, so the canonical separator is "," with no spaces. We
 *  collapse internal whitespace to a single space and drop empties /
 *  oversize tokens. */
export function parseTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((t) => t.trim().replace(/\s+/g, " "))
        .filter((t) => t.length >= 1 && t.length <= 80),
    ),
  );
}

/** Capitalise the first letter of a string. Used in toast headlines
 *  like "Title alternatives ready". Empty input passes through. */
export function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
