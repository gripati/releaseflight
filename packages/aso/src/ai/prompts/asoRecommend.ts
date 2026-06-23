/**
 * aso.recommend — comprehensive ASO recommendation pack.
 *
 * Given an app's current metadata (per locale) + currently tracked
 * keyword performance + recent download trends, the AI returns a
 * single response with:
 *
 *   • topKeywords[locale]   — 5 candidate keywords ranked by predicted
 *                             impact, each with reasoning
 *   • titlesByLocale        — up to 3 title variants per locale,
 *                             ranked, each with reasoning
 *   • subtitlesByLocale     — up to 3 subtitle variants per locale
 *                             (≤30 chars, iOS only)
 *   • promosByLocale        — up to 3 promotional text variants per
 *                             locale (≤170 chars, iOS only)
 *   • topPick               — the single highest-confidence change to
 *                             make next, with a clear cost/benefit
 *                             argument
 *   • notes                 — overall observations the model wants the
 *                             user to know
 *
 * The system prompt is intentionally verbose — ASO rationale is the
 * product. We want the user to understand *why* each suggestion was
 * made, not just see a list.
 */
import { z } from "zod";
import type { AiTask } from "../types";

export interface AsoRecommendInput {
  appName: string;
  bundleId: string;
  primaryLocale: string;
  platform: "IOS" | "ANDROID";
  /** Genre / category Apple/Google place the app in. */
  primaryGenre: string | null;
  /** All locales on the app, with their current ASO-relevant fields. */
  locales: {
    locale: string;
    languageName: string;
    isPrimary: boolean;
    name: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    description: string | null;
  }[];
  /** Already-tracked keywords with their latest performance signals.
   *  Astro / third-party MCP signals are passed through when present
   *  so the model can rank suggestions like a professional consultant. */
  trackedKeywords: {
    keyword: string;
    territory: string;
    score: number | null;
    rank: number | null;
    bucket: string | null;
    inField: boolean;
    /** Astro popularity (0–100). Apple's real search index. */
    volume?: number | null;
    /** Theoretical max volume scale (typically 100). */
    maxVolume?: number | null;
    /** Astro difficulty 0–100 — higher = harder to rank for. */
    difficulty?: number | null;
    /** Astro max reach chance — impressions if ranked #1. */
    maxReachChance?: number | null;
  }[];
  /** Last 30-day download totals — gives the model context for impact. */
  downloads30d: number;
  /** Day-over-day download delta % — flags whether we're trending. */
  downloadsTrendPct: number | null;
}

// ────────────────────────────────────────────────────────────────────
// Output schema
// ────────────────────────────────────────────────────────────────────

const KeywordRec = z.object({
  keyword: z
    .string()
    .min(1)
    .max(80)
    .describe("The exact term users would type into the App Store"),
  predictedImpact: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("0-100 subjective fit score. Not a popularity claim."),
  reasoning: z
    .string()
    .min(20)
    .max(280)
    .describe("Why this term fits THIS app — reference its genre / mechanic / audience"),
  category: z.enum([
    "CORE",
    "LONG_TAIL",
    "COMPETITOR_BORROW",
    "SYNONYM",
    "BRAND",
  ]),
  /** Should the user drop a current keyword to make room? */
  replaces: z.string().max(80).optional().describe("If swapping, which current token to drop"),
});

const TextAlternative = z.object({
  text: z.string().min(1).max(300),
  predictedImpact: z.number().int().min(0).max(100),
  reasoning: z
    .string()
    .min(20)
    .max(280)
    .describe("Why this version performs better than the current one"),
});

const TopPick = z.object({
  change: z.enum(["KEYWORD", "TITLE", "SUBTITLE", "PROMO"]),
  locale: z.string().min(2).max(20),
  summary: z.string().min(20).max(200),
  expectedLift: z
    .string()
    .min(10)
    .max(200)
    .describe("Plain-English statement of likely lift. NOT a numeric claim."),
});

const LocaleTextBucket = z.object({
  locale: z.string().min(2).max(20),
  alternatives: z.array(TextAlternative).max(3),
});

export const AsoRecommendOutput = z.object({
  topPick: TopPick,
  topKeywordsByLocale: z
    .array(
      z.object({
        locale: z.string().min(2).max(20),
        suggestions: z.array(KeywordRec).min(1).max(5),
      }),
    )
    .min(1)
    .max(20),
  /** Per-locale title alternatives. Every locale in the input gets a bucket;
   *  if the model has nothing new to say for a locale it returns []. */
  titlesByLocale: z.array(LocaleTextBucket).min(1).max(20),
  /** Per-locale subtitle alternatives (iOS only). */
  subtitlesByLocale: z.array(LocaleTextBucket).max(20),
  /** Per-locale promotional text alternatives (iOS only). */
  promosByLocale: z.array(LocaleTextBucket).max(20),
  notes: z.string().max(400).optional(),
});

export type AsoRecommendOutput = z.infer<typeof AsoRecommendOutput>;

// JSON-Schema mirror for providers that demand a literal schema.
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topPick", "topKeywordsByLocale", "titlesByLocale"],
  properties: {
    topPick: {
      type: "object",
      additionalProperties: false,
      required: ["change", "locale", "summary", "expectedLift"],
      properties: {
        change: { type: "string", enum: ["KEYWORD", "TITLE", "SUBTITLE", "PROMO"] },
        locale: { type: "string", minLength: 2, maxLength: 20 },
        summary: { type: "string", minLength: 20, maxLength: 200 },
        expectedLift: { type: "string", minLength: 10, maxLength: 200 },
      },
    },
    topKeywordsByLocale: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["locale", "suggestions"],
        properties: {
          locale: { type: "string", minLength: 2, maxLength: 20 },
          suggestions: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["keyword", "predictedImpact", "reasoning", "category"],
              properties: {
                keyword: { type: "string", minLength: 1, maxLength: 80 },
                predictedImpact: { type: "integer", minimum: 0, maximum: 100 },
                reasoning: { type: "string", minLength: 20, maxLength: 280 },
                category: {
                  type: "string",
                  enum: ["CORE", "LONG_TAIL", "COMPETITOR_BORROW", "SYNONYM", "BRAND"],
                },
                replaces: { type: "string", maxLength: 80 },
              },
            },
          },
        },
      },
    },
    titlesByLocale: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: localeTextBucketSchema(),
    },
    subtitlesByLocale: {
      type: "array",
      maxItems: 20,
      items: localeTextBucketSchema(),
    },
    promosByLocale: {
      type: "array",
      maxItems: 20,
      items: localeTextBucketSchema(),
    },
    notes: { type: "string", maxLength: 400 },
  },
} as const;

function localeTextBucketSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["locale", "alternatives"],
    properties: {
      locale: { type: "string", minLength: 2, maxLength: 20 },
      alternatives: { type: "array", maxItems: 3, items: textAlternativeSchema() },
    },
  };
}

function textAlternativeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["text", "predictedImpact", "reasoning"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 300 },
      predictedImpact: { type: "integer", minimum: 0, maximum: 100 },
      reasoning: { type: "string", minLength: 20, maxLength: 280 },
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// System prompt — verbose by design
// ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are an elite **ASO + GEO + AEO App Discoverability Strategist** —
combining a senior ASO consultant, SEO/GEO analyst, answer-engine
specialist, conversion copywriter, localization analyst, and growth
experiment designer. Your job is to recommend SPECIFIC, DEFENSIBLE
metadata changes — never vague advice.

Always optimize for:
  1. Right query reaches the right user (relevance over vanity volume).
  2. Right user installs (intent match drives retention + revenue).
  3. Search + AI systems represent the app accurately (entity clarity).
  4. Recommendations prioritised by IMPACT × CONFIDENCE × EFFORT.

═══════════════════════════════════════════════════════════════════════
SLOT-WEIGHT HIERARCHY — where to invest the strongest tokens
═══════════════════════════════════════════════════════════════════════
  1. App name          weight 1.00   highest visible field
  2. Subtitle          weight 0.85   indexed SAME as keywords field
  3. Keywords field    weight 0.60   hidden, char-efficiency critical
  4. Promo text        weight 0.00 rank / 0.60 conversion
  5. Description       weight 0.30 (Apple barely indexes; Google Play
                                    indexes the full text + AEO/GEO)
  6. Screenshot lead   weight 0.55 conversion only

NEVER waste the strongest slots (title, subtitle) on low-relevance
vanity terms. Painkiller > vitamin every time.

═══════════════════════════════════════════════════════════════════════
KEYWORDS FIELD (iOS, ≤ 100 chars per locale)
═══════════════════════════════════════════════════════════════════════
  • Comma-separated, NO spaces (every char counts).
  • Don't repeat tokens already in title / subtitle — Apple indexes
    them for free; duplication is wasted budget.
  • Mix clusters: CORE + LONG_TAIL + 1-2 COMPETITOR_BORROW + SYNONYM.
    Add PAINKILLER terms when the mechanic supports them.
  • Singular > plural when both work — Apple stems.
  • Multi-word phrases allowed and often higher-converting.
  • Char-efficiency is critical — a 12-char long-tail with strong
    intent beats a 25-char vanity phrase with marginal volume.

═══════════════════════════════════════════════════════════════════════
TITLE (≤ 30 chars on iOS and Google Play)
═══════════════════════════════════════════════════════════════════════
  • Pattern: "BrandNoun: Genre / Outcome Hook"
  • First 23 chars matter most — Apple truncates in browse rows.
  • Lead with a UNIQUE NOUN; avoid generic verbs.
  • Don't laundry-list keywords ("BrandName: Battle Strategy War Tower
    Game") — dilutes brand identity, signals spam.
  • Compliance: no "best", "#1", "free", "sale", "award winning" —
    App Review + Play policy reject promotional claims.
  • Trademark safety — no competitor brand names.

═══════════════════════════════════════════════════════════════════════
SUBTITLE (≤ 30 chars, iOS only — second-highest ASO field)
═══════════════════════════════════════════════════════════════════════
  • Indexed SAME weight as keywords field. Effectively 30 extra
    characters of keyword surface that ALSO shows visibly.
  • NEVER echo title words.
  • Pick a NEW angle from one of these clusters:
      Audience ("with friends") / Mechanic ("idle defense") /
      Outcome ("track triggers") / Differentiator ("no ads, no IAP")
  • Front-load the highest-value search term still missing from title.

═══════════════════════════════════════════════════════════════════════
PROMOTIONAL TEXT (≤ 170 chars, iOS only — conversion only, NOT indexed)
═══════════════════════════════════════════════════════════════════════
Only field that updates instantly — daily iteration is fine.
Best uses (in priority order):
  1. Time-sensitive event ("New season launches Friday")
  2. Specific recent improvement ("Now with controller support")
  3. Verifiable social proof ("3.5M players worldwide")
  4. Active offer / event ("Halloween skins live now")
Never stuff keywords here — they don't index.

═══════════════════════════════════════════════════════════════════════
PAINKILLER > VITAMIN — bias toward urgent, recurring problems
═══════════════════════════════════════════════════════════════════════
Painkiller keywords represent URGENT, RECURRING, HIGH-PAIN problems
the user actively wants solved. They convert 2-5× better than vitamin
terms and justify slightly higher difficulty.

Examples:
  Health       "headache tracker", "chronic pain log", "symptom diary"
  Productivity "block distractions", "focus timer", "password vault"
  Games        "offline puzzle", "no-internet game", "kid-safe game"

When recommending changes, FLAG which suggestions are painkiller vs
vitamin — boost painkiller scores when the app's mechanic supports.

═══════════════════════════════════════════════════════════════════════
RANKING + REASONING
═══════════════════════════════════════════════════════════════════════
For each suggestion:
  1. Rank predictedImpact 0-100. USE THE FULL RANGE — don't cluster
     at 70-80. Vanity suggestions score 30-50; only true painkiller
     fits scoring 90+.
  2. Reasoning in PLAIN ENGLISH referencing THIS app's genre /
     mechanic / audience. Generic ("this is a popular term") is
     unhelpful and gets ignored.
  3. When adding a new keyword that pushes the locale over 100 chars,
     set "replaces" to the weakest current token — the swap is
     concrete.
  4. Bias the recommendation set to LOW-DIFFICULTY winnable terms for
     new / low-authority apps. Don't chase huge category terms unless
     the app has authority to back the claim.

topPick = THE SINGLE most important change across all locales + fields.
Be opinionated. One pick. Don't hedge.

═══════════════════════════════════════════════════════════════════════
EVIDENCE HIERARCHY — what's defensible
═══════════════════════════════════════════════════════════════════════
  1. Official platform policy + docs.
  2. First-party analytics: ASC, Play Console, Apple Ads.
  3. Directly observed App Store SERP.
  4. Multi-tool triangulation.
  5. Competitor metadata + review themes.
  6. Heuristics.
  7. Generic ASO claims — discount unless proven.

Never blindly average conflicting tool signals — explain WHICH metric
is more trustworthy for this decision.

═══════════════════════════════════════════════════════════════════════
THIRD-PARTY RESEARCH SIGNALS — how to weight them
═══════════════════════════════════════════════════════════════════════
When the user's "Currently tracked keywords" table includes \`volume\`,
\`maxVolume\`, \`difficulty\`, or \`maxReachChance\` columns, treat them
as Astro / AppTweak / Sensor Tower-class signals and reason with the
discipline of a professional ASO consultant:

  • \`volume\` is monthly searches (third-party model). High volume is
    only useful when paired with LOW difficulty and HIGH maxReachChance.
  • \`difficulty\` 0-100: above 65 a new / low-authority app cannot
    realistically break top-10. Below 35 is "winnable" — bias toward
    these for keyword swaps.
  • \`maxReachChance\` 0-100: probability of reaching top-10 with strong
    metadata. ≥ 40 is "go" territory; < 20 is "skip even if volume
    looks tempting".
  • \`volume\` (0-100) is Astro's popularity — Apple's real search
    index. High volume means the term is searched, but doesn't
    guarantee winnability.

Cross-signal logic:
  • High volume + difficulty > 65 + maxReachChance < 20 → AVOID. Vanity
    keyword that drains slot weight.
  • Mid volume + difficulty < 35 + maxReachChance ≥ 40 → PRIORITISE.
    This is the painkiller-adjacent "winnable" slot.
  • Low volume + low difficulty + high maxReachChance → use as a
    long-tail combo, NOT a hero term.

NEVER invent Astro numbers for keywords NOT in the table.

═══════════════════════════════════════════════════════════════════════
MANDATORY NEGATIVE DIRECTIVES — never do these
═══════════════════════════════════════════════════════════════════════
  • NEVER promise numeric rank, popularity, install volume, or
    revenue. Real numbers come from APIs, not you.
  • NEVER recommend trademarked competitor NAMES verbatim — paraphrase
    the search intent.
  • NEVER invent features the app doesn't have — AI systems may quote
    them and create policy risk.
  • NEVER use banned promo terms in title / subtitle / desc ("best",
    "#1", "free", "sale", "award winning").
  • NEVER overclaim in medical / financial / legal / child categories.
  • NEVER stuff keywords (Tags: section, repeated tokens, ALL CAPS).
  • NEVER mix English keywords into non-English locales.

═══════════════════════════════════════════════════════════════════════
LOCALE STRATEGY — produce per-locale variants for ALL four fields
═══════════════════════════════════════════════════════════════════════
  • Each locale is its OWN optimization problem.
  • Title, subtitle, promo AND keyword suggestions must be generated
    PER LOCALE. Return a bucket for every locale we provide — empty
    \`alternatives: []\` is acceptable if current copy is already
    strong, but do NOT skip locales silently.
  • Title + subtitle + promo MUST be written in the locale's NATIVE
    LANGUAGE. Never return English text inside a tr-TR / ja / zh-Hans
    / de-DE / hr / sk bucket.
  • For en-US / en-GB / en-AU: differences are subtle (spelling,
    slang). Don't return identical 5-keyword sets — vary 1-2 terms.
  • For non-English locales: TRANSLITERATE brand borrows correctly
    ("tetris" → "テトリス" in ja, "тетрис" in ru).
  • Cap output at the locales requested. Don't volunteer new ones.
`.trim();

export function buildAsoRecommendTask(
  input: AsoRecommendInput,
): AiTask<AsoRecommendInput, AsoRecommendOutput> {
  return {
    kind: "metadata.tighten",
    input,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: renderUserPrompt(input),
    outputSchema: AsoRecommendOutput,
    jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    taskName: "submit_aso_recommendations",
    taskDescription:
      "Return the comprehensive ASO recommendation pack for this app — keywords per locale, title/subtitle/promo alternatives, and the single top-pick change.",
    maxOutputTokens: 4096,
    temperature: 0.45,
  };
}

function renderUserPrompt(input: AsoRecommendInput): string {
  const lines: string[] = [];
  lines.push(`# App context`);
  lines.push(`Name:           ${input.appName}`);
  lines.push(`Bundle ID:      ${input.bundleId}`);
  lines.push(`Platform:       ${input.platform}`);
  lines.push(`Primary locale: ${input.primaryLocale}`);
  if (input.primaryGenre) lines.push(`Genre:          ${input.primaryGenre}`);
  lines.push(`30-day downloads: ${input.downloads30d.toString()}`);
  if (input.downloadsTrendPct !== null) {
    const arrow = input.downloadsTrendPct > 0 ? "▲" : input.downloadsTrendPct < 0 ? "▼" : "→";
    lines.push(
      `Trend vs prev 30d: ${arrow} ${input.downloadsTrendPct.toFixed(1)}%`,
    );
  }

  lines.push("");
  lines.push("# Current metadata per locale");
  for (const loc of input.locales) {
    lines.push(`## ${loc.locale} — ${loc.languageName}${loc.isPrimary ? " (primary)" : ""}`);
    if (loc.name) lines.push(`Title:    ${loc.name}`);
    if (loc.subtitle) lines.push(`Subtitle: ${loc.subtitle}`);
    if (loc.keywordsField !== null && loc.keywordsField !== "") {
      lines.push(`Keywords field (${loc.keywordsField.length.toString()}/100): ${loc.keywordsField}`);
    } else {
      lines.push(`Keywords field: <empty>`);
    }
    if (loc.promotionalText) lines.push(`Promo: ${loc.promotionalText}`);
    if (loc.description) {
      const truncated = loc.description.trim().slice(0, 600);
      lines.push(`Description (first 600 chars): ${truncated}`);
    }
    lines.push("");
  }

  if (input.trackedKeywords.length > 0) {
    const top = input.trackedKeywords.slice(0, 60);
    const hasResearch = top.some(
      (k) =>
        k.volume != null ||
        k.maxVolume != null ||
        k.difficulty != null ||
        k.maxReachChance != null,
    );
    lines.push("# Currently tracked keywords with measured performance");
    if (hasResearch) {
      lines.push(
        "(format: keyword | territory | score | rank | bucket | inField | volume (0-100) | maxVol | difficulty (0-100) | maxReachChance (0-100))",
      );
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.territory} | ${k.score ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"} | ${k.inField ? "live" : "tracked"} | ${k.volume ?? "—"} | ${k.maxVolume ?? "—"} | ${k.difficulty ?? "—"} | ${k.maxReachChance ?? "—"}`,
        );
      }
      lines.push("");
      lines.push(
        "Use the Astro signals like an ASO consultant: prefer suggestions whose tracked neighbours show high volume + LOW difficulty + maxReachChance ≥ 40. Call out the Astro evidence in `reasoning` (e.g. \"neighbouring term 'X' has volume 75 with difficulty 18 — winnable slot\"). Do NOT invent volume/difficulty for keywords NOT in this table; if you propose a brand-new term, justify it on relevance + slot-weight + painkiller fit instead.",
      );
    } else {
      lines.push(
        "(format: keyword | territory | score | rank | bucket | inField)",
      );
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.territory} | ${k.score ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"} | ${k.inField ? "live" : "tracked"}`,
        );
      }
      lines.push("");
      lines.push(
        "Note: Astro signals (volume / difficulty / maxReachChance) aren't connected for this tenant yet. Rank suggestions on relevance + slot-weight + painkiller framing — do NOT invent numeric estimates.",
      );
    }
    lines.push("");
  }

  lines.push("# Your task");
  lines.push(
    "Produce the ASO recommendation pack as described in the schema. Pick ONE topPick — be opinionated.",
  );
  lines.push(
    "Every input locale must appear in topKeywordsByLocale, titlesByLocale and subtitlesByLocale.",
  );
  lines.push(
    "promosByLocale is iOS-only; skip the bucket for Android apps. Use the locale's native language for all text alternatives.",
  );
  lines.push(
    "Empty `alternatives: []` is OK when the current copy is already strong; do NOT silently drop a locale.",
  );
  return lines.join("\n");
}
