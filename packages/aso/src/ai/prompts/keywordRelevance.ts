/**
 * keyword.relevance — score each candidate keyword's relevance to the
 * app's actual category / mechanic / audience. Used by AstroAutopilot
 * to drop unrelated competitor-mined candidates (e.g. "saw → sniper
 * games" for a block-breaker game, "puzzle → photo collage" because a
 * photo-collage app happens to rank for "puzzle").
 *
 * Astro's mining returns competitor candidates from ANY app that ranks
 * for the seed keyword. Many of those apps belong to totally different
 * categories (photo, finance, music) but use the seed term somewhere
 * in their metadata. Without this filter the autopilot surfaces them
 * as "stronger alternatives" — which is technically true on Astro's
 * popularity signal but semantically wrong.
 *
 * Output: per-candidate relevance score 0-100 with a one-line reason.
 *   • 90+ describes the app's mechanic (e.g. "block breaker", "brick game")
 *   • 70-89 same genre (e.g. "puzzle game", "arcade game")
 *   • 40-69 adjacent / generic (e.g. "casual game", "offline")
 *   • <40 unrelated app category — DROP.
 */
import { z } from "zod";
import type { AiTask } from "../types";

/** Compact per-locale metadata bundle. Mirrors AppLocalization columns
 *  so the relevance scorer can read what the app says about itself in
 *  EVERY locale, not just the one being analyzed. */
export interface LocaleMetadataSummary {
  locale: string;
  /** True when this is the app's primary storefront locale — the
   *  scorer should weight its tone slightly more heavily. */
  isPrimary: boolean;
  title: string | null;
  subtitle: string | null;
  keywordsField: string | null;
  promotionalText: string | null;
  /** Truncated to ~600 chars before passing in (caller's responsibility
   *  — keeps prompt budget under control on long descriptions). */
  description: string | null;
}

export interface KeywordRelevanceInput {
  appName: string;
  primaryGenre: string | null;
  bundleId: string;
  /** Locale of the keywords currently being scored — these are
   *  candidates from the Astro pool for THIS territory. */
  localeCode: string;
  storeCode: string;
  /** Legacy single-locale metadata block. Kept for backward
   *  compatibility with callers that haven't migrated to
   *  `allLocalesMetadata` yet. New callers should populate
   *  `allLocalesMetadata` instead so the scorer sees cross-locale
   *  consensus (e.g. en-US title "Block Breaker" + tr-TR
   *  subtitle "tuğla kırma" both confirm the mechanic). */
  currentMetadata?: {
    title: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    description: string | null;
  };
  /** Full multi-locale metadata bundle. When present, takes priority
   *  over `currentMetadata` — the scorer reads every locale to
   *  understand the app's positioning globally. Truncate description
   *  to ~600 chars per locale before passing. */
  allLocalesMetadata?: LocaleMetadataSummary[];
  candidates: {
    keyword: string;
    popularity: number | null;
    difficulty: number | null;
  }[];
}

export const KeywordRelevanceScore = z.object({
  keyword: z.string().min(1),
  relevance: z.number().int().min(0).max(100),
  reason: z.string().nullable(),
});

export const KeywordRelevanceOutput = z.object({
  scores: z.array(KeywordRelevanceScore),
});
export type KeywordRelevanceOutput = z.infer<typeof KeywordRelevanceOutput>;

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["keyword", "relevance", "reason"],
        properties: {
          keyword: { type: "string" },
          relevance: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `
You are a senior App Store ASO consultant. Your job is to rate how
RELEVANT each candidate keyword is to a specific app.

═══════════════════════════════════════════════════════════════════════
RELEVANCE SCALE (0-100)
═══════════════════════════════════════════════════════════════════════
  90-100 — Describes the app's CORE MECHANIC or CATEGORY directly.
           Example for "Block Breaker game": "block breaker" 95,
           "brick game" 92, "ball bounce" 88.
  70-89  — Same GENRE or close adjacency. Example: "puzzle game" 78,
           "arcade game" 75, "casual game" 72.
  40-69  — Adjacent / generic. Could fit but isn't specific. Example:
           "free game" 55, "fun game" 50.
  0-39   — UNRELATED app category. Drop these. Examples for a
           block-breaker game:
             • "photo collage" — Photo & Video app term
             • "credit card" — Finance app term
             • "sniper games" — Different genre (FPS)
             • "music maker" — Music creation app term
             • "flow free" — A specific competitor in a different
               puzzle subgenre

═══════════════════════════════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════════════════════════════
  • A keyword can be high-popularity AND low-relevance — popularity
    does NOT save irrelevant terms. "credit card" might be popular but
    it's irrelevant to a block-breaker game.
  • If the candidate is a TRADEMARKED competitor's NAME (e.g.
    "subway surfers", "candy crush", "royal match"), score 35-55 —
    it's relevant but trademark-risky to copy verbatim. The user can
    decide.
  • If the candidate is generic ASO noise ("game", "best", "free",
    "new", "top"), score 30-40 — these appear in every metadata but
    add no targeted value.
  • If you're not sure whether a candidate fits the app, default to
    50 (neutral) and explain in the reason.
  • Provide a SHORT plain-English reason for each score (10-25
    words). Use the same language as the app's locale.

═══════════════════════════════════════════════════════════════════════
CROSS-LOCALE GROUNDING
═══════════════════════════════════════════════════════════════════════
When the prompt includes metadata across multiple locales, treat the
union as the SOURCE OF TRUTH for what the app IS. Examples:
  • en-US title says "Block Breaker" + tr-TR subtitle says "tuğla
    kırma" → mechanic is BLOCK BREAKING (confirmed in two markets).
  • es-ES description mentions "modo sin internet" → "offline play"
    is part of the app's positioning even when the candidate is in
    en-US.
  • If a candidate's intent contradicts the multi-locale consensus
    (e.g. "photo editor" candidate when the app is uniformly a
    block-breaker game across 8 locales), score ≤ 20.
Don't penalise a candidate just because the locale being scored
hasn't mentioned the concept yet — that's exactly the kind of cross-
locale opportunity the autopilot exists to surface.

═══════════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════════
Return exactly one score per input candidate. Do not invent new
candidates. Preserve the original keyword spelling.
`.trim();

export function buildKeywordRelevanceTask(
  input: KeywordRelevanceInput,
): AiTask<KeywordRelevanceInput, KeywordRelevanceOutput> {
  const lines: string[] = [];
  lines.push("# App");
  lines.push(`Name:       ${input.appName}`);
  lines.push(`Bundle ID:  ${input.bundleId}`);
  if (input.primaryGenre) lines.push(`Genre:      ${input.primaryGenre}`);
  lines.push(`Locale:     ${input.localeCode}`);
  lines.push(`Storefront: ${input.storeCode.toUpperCase()}`);

  // Prefer the full cross-locale bundle when present. The scorer
  // then sees how the app pitches itself in every market — keywords
  // that match the GLOBAL consensus get higher relevance than ones
  // that only fit one locale's tone.
  if (input.allLocalesMetadata && input.allLocalesMetadata.length > 0) {
    lines.push("");
    lines.push(
      `# Metadata across ${input.allLocalesMetadata.length.toString()} locale(s) — use the cross-locale consensus to ground relevance`,
    );
    // Sort: primary first, then alphabetical so the AI lands on the
    // canonical pitch before reading translations.
    const ordered = [...input.allLocalesMetadata].sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.locale.localeCompare(b.locale);
    });
    for (const m of ordered) {
      lines.push("");
      lines.push(`## ${m.locale}${m.isPrimary ? " (primary)" : ""}`);
      if (m.title) lines.push(`Title:       ${m.title}`);
      if (m.subtitle) lines.push(`Subtitle:    ${m.subtitle}`);
      if (m.keywordsField) lines.push(`Keywords:    ${m.keywordsField}`);
      if (m.promotionalText) lines.push(`Promo:       ${m.promotionalText}`);
      if (m.description) {
        const truncated = m.description.trim().slice(0, 600);
        lines.push(`Description: ${truncated}`);
      }
    }
  } else if (input.currentMetadata) {
    // Legacy single-locale path — kept for backward compat.
    const m = input.currentMetadata;
    lines.push("");
    lines.push("# Current metadata (use this to ground relevance)");
    if (m.title) lines.push(`Title:       ${m.title}`);
    if (m.subtitle) lines.push(`Subtitle:    ${m.subtitle}`);
    if (m.keywordsField) lines.push(`Keywords:    ${m.keywordsField}`);
    if (m.promotionalText) lines.push(`Promo:       ${m.promotionalText}`);
    if (m.description) {
      const truncated = m.description.trim().slice(0, 600);
      lines.push(`Description (first 600 chars):`);
      lines.push(truncated);
    }
  }

  lines.push("");
  lines.push(`# Candidates (${input.candidates.length.toString()})`);
  lines.push("keyword | Apple popularity | Apple difficulty");
  for (const c of input.candidates) {
    lines.push(
      `  ${c.keyword} | ${c.popularity?.toString() ?? "—"} | ${c.difficulty?.toString() ?? "—"}`,
    );
  }
  lines.push("");
  lines.push(
    `Return a relevance 0-100 for EACH candidate. Drop nothing — even score 0 for unrelated terms. The autopilot uses the scores to filter on its side.`,
  );

  return {
    kind: "keyword.suggest",
    input,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: lines.join("\n"),
    outputSchema: KeywordRelevanceOutput,
    jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    taskName: "submit_keyword_relevance_scores",
    taskDescription:
      "Score each candidate keyword's relevance to the app's actual category / mechanic / audience.",
    maxOutputTokens: 2048,
    temperature: 0.2,
  };
}
