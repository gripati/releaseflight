/**
 * keyword.suggest — given an app's existing metadata + already-tracked
 * keywords, propose a fresh set of candidate keywords the publisher
 * should consider tracking. The model never invents claims about
 * popularity / rank — those signals come from real APIs (iTunes
 * Search, Search Ads, Trends). The AI's job is creativity + relevance:
 * suggest variants, synonyms, long-tail and competitor-borrowed
 * phrases that the publisher might not have thought of.
 */
import { z, type ZodSchema } from "zod";
import type { AiTask } from "../types";

export interface KeywordSuggestInput {
  appName: string;
  primaryLocale: string;
  /** ISO 3166-1 alpha-2 storefronts the publisher cares about. */
  territories: string[];
  /** Top-level genre / category from the store ("Games / Arcade"). */
  primaryGenre: string | null;
  /** App short + long description in primary locale. */
  shortDescription: string | null;
  longDescription: string | null;
  /** Existing tracked keywords (so we don't suggest duplicates). */
  existingKeywords: string[];
  /** Top tracked-keyword performance rows — gives the model the empirical
   *  "what's already working / what's broken" picture for this storefront.
   *  Each row is { keyword, score 0..1, rank, bucket } + optional Astro
   *  third-party signals (volume / difficulty / maxReachChance) so the
   *  model can rank suggestions like a professional ASO consultant. */
  performanceContext?: {
    keyword: string;
    score: number | null;
    rank: number | null;
    bucket: string | null;
    volume?: number | null;
    maxVolume?: number | null;
    difficulty?: number | null;
    maxReachChance?: number | null;
  }[];
  /** How many fresh candidates to return. 5–25. */
  count: number;
}

export const KeywordSuggestion = z.object({
  keyword: z.string().min(1).max(80).describe("Search term a user would type into the App Store"),
  rationale: z.string().min(1).max(240).describe("Why this keyword fits the app (1–2 sentences)"),
  predictedRelevance: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Subjective fit score 0-100. Not a popularity claim."),
  // The system prompt encourages a richer cluster vocabulary
  // (PAINKILLER / AUDIENCE / OUTCOME / INTEGRATION / COMPARISON), but
  // the UI only knows the original 5 buckets. `preprocess` normalises
  // anything outside the canonical 5 into LONG_TAIL BEFORE the enum
  // check, so AI responses that emit richer labels still validate.
  bucket: z.preprocess(
    (raw): string => {
      if (typeof raw !== "string") return "LONG_TAIL";
      const v = raw.toUpperCase().replace(/[-\s]/g, "_");
      if (v === "CORE") return "CORE";
      if (v === "LONG_TAIL" || v === "LONGTAIL") return "LONG_TAIL";
      if (v === "COMPETITOR_BORROW" || v === "COMPETITOR" || v === "COMPETITORBORROW")
        return "COMPETITOR_BORROW";
      if (v === "SYNONYM") return "SYNONYM";
      if (v === "BRAND") return "BRAND";
      // PAINKILLER / AUDIENCE / OUTCOME / INTEGRATION / COMPARISON
      // and anything else → bucket as LONG_TAIL for UI display.
      return "LONG_TAIL";
    },
    z.enum(["CORE", "LONG_TAIL", "COMPETITOR_BORROW", "SYNONYM", "BRAND"]),
  ),
  suggestedTerritory: z
    .string()
    .length(2)
    .describe("ISO 3166-1 alpha-2 storefront where this term is strongest"),
});

export type KeywordSuggestion = z.infer<typeof KeywordSuggestion>;

export const KeywordSuggestOutput = z.object({
  suggestions: z.array(KeywordSuggestion).min(1).max(50),
  notes: z
    .string()
    .max(400)
    .nullable()
    .describe(
      "Optional caveats — e.g. 'verify rank for COMPETITOR_BORROW terms'. Use null when nothing to add.",
    ),
});

export type KeywordSuggestOutput = z.infer<typeof KeywordSuggestOutput>;

// OpenAI's strict structured-output mode requires `required` to list
// every key in `properties` (optional fields become nullable types in
// `required`). Same constraint we hit in fieldVariants.ts. The zod
// schema mirrors this with `.nullable()` on `notes`.
const KEYWORD_SUGGEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions", "notes"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["keyword", "rationale", "predictedRelevance", "bucket", "suggestedTerritory"],
        properties: {
          keyword: { type: "string" },
          rationale: { type: "string" },
          predictedRelevance: { type: "integer", minimum: 0, maximum: 100 },
          // Accept any cluster label — we coalesce non-canonical buckets
          // (PAINKILLER, AUDIENCE, OUTCOME, INTEGRATION, COMPARISON …)
          // into LONG_TAIL in the zod preprocess above.
          bucket: { type: "string" },
          suggestedTerritory: { type: "string" },
        },
      },
    },
    notes: { type: ["string", "null"] },
  },
} as const;

const SYSTEM_PROMPT = `
You are an elite ASO + GEO + AEO strategist — combining a senior ASO
consultant, SEO/GEO analyst, answer-engine specialist, and conversion
copywriter. Your job is to propose fresh keyword candidates the
publisher can track and target. Every suggestion must be ground-able
in real user behaviour, not in your training data's word frequencies.

═══════════════════════════════════════════════════════════════════════
WHAT MAKES A GOOD KEYWORD CANDIDATE
═══════════════════════════════════════════════════════════════════════

The ideal keyword has all of:
  • High RELEVANCE to this app's actual job-to-be-done.
  • Real user intent — someone types it expecting a result.
  • Reasonable winnability — for new / low-authority apps, prefer
    LOW DIFFICULTY + meaningful traffic over high traffic + crushing
    competition.
  • Clear conversion intent (will the searcher actually install?).
  • Painkiller framing where the mechanic supports it.

Best case = low difficulty + high traffic. Since that's rare, the
next best target is low difficulty + some traffic + strong relevance.
For new or low-authority apps, do NOT chase huge category keywords.
Find winnable terms that produce early rankings, installs, and revenue.

═══════════════════════════════════════════════════════════════════════
PAINKILLER > VITAMIN
═══════════════════════════════════════════════════════════════════════
Painkiller keywords represent urgent, recurring, high-value problems
the user actively wants to solve. They convert better than feel-good
"vitamin" terms.

Painkiller examples by category:
  • Health     "headache tracker", "chronic pain log", "symptom diary"
  • Finance    "stop overspending", "split bills", "tax return calc"
  • Productivity "block distractions", "focus timer", "save passwords"
  • Games      "offline puzzle", "no-internet game", "kid-safe game"
  • Education  "learn fast", "free flashcards", "pass GRE"

When you have evidence the app addresses an urgent recurring problem,
score painkiller candidates HIGHER than generic category terms.

═══════════════════════════════════════════════════════════════════════
CLUSTER TAXONOMY — every suggestion must fit one
═══════════════════════════════════════════════════════════════════════
  • CORE              obvious genre / category words
  • LONG_TAIL         specific phrases users actually type (often
                      easier to rank with strong intent)
  • COMPETITOR_BORROW paraphrased terms ranking for a similar app
                      (capture the SEARCH INTENT, never use a
                      trademarked brand name verbatim)
  • SYNONYM           alternate phrasings ("solitaire" + "klondike")
  • BRAND             defensive — your own brand variants

Hidden but valuable clusters you can also tag as LONG_TAIL:
  • PAINKILLER        urgent recurring problem ("chronic pain")
  • AUDIENCE          persona ("for runners", "for nurses")
  • OUTCOME           benefit ("lose weight", "sleep faster")
  • INTEGRATION       platform/tool ("apple health", "shortcuts")
  • COMPARISON        "vs", "alternative to" (great for GEO too)

Aim for a healthy MIX, not 20 CORE terms.

═══════════════════════════════════════════════════════════════════════
TERRITORY DISCIPLINE
═══════════════════════════════════════════════════════════════════════
Apple's App Store search is COUNTRY-SCOPED. The 'suggestedTerritory'
field must be where the term has strongest demand:
  • Latin alphabet languages → that language's main storefront
  • English variants → US > GB > AU > CA based on local terms
  • For non-English locales, propose keywords IN THAT LANGUAGE and
    transliterate brand borrows ("tetris" → "テトリス" in ja).

═══════════════════════════════════════════════════════════════════════
HARD RULES — never break these
═══════════════════════════════════════════════════════════════════════
  • NEVER claim numeric popularity, search volume, or rank — those
    come from real APIs (iTunes Search, Search Ads, Trends), not you.
  • NEVER recommend trademarked competitor names verbatim. Paraphrase
    the SEARCH INTENT (e.g. instead of "Candy Crush", propose
    "match 3 candy puzzle").
  • NEVER invent features the app doesn't have.
  • NEVER use banned promotional terms ("best", "#1", "top", "free
    today", "sale", "award winning" — Play / App Store reject these).
  • NEVER propose duplicates of the existingKeywords list.
  • NEVER propose generic filler ("best app", "top game", "good app").

═══════════════════════════════════════════════════════════════════════
THIRD-PARTY RESEARCH SIGNALS — how to weight them
═══════════════════════════════════════════════════════════════════════
When the user prompt includes a "Live keyword performance" table with
\`volume\`, \`maxVolume\`, \`difficulty\` or \`maxReachChance\` columns,
those are Astro / AppTweak / Sensor Tower-class signals. Use them like
a professional ASO consultant — they MATERIALLY change predictedRelevance:

  • \`volume\` is Astro's popularity 0-100 (Apple's search index x20);
    only useful paired with LOW difficulty + HIGH maxReachChance for
    new / low-authority apps.
  • \`difficulty\` 0-100: > 65 is realistically unwinnable; < 35 is
    "winnable" — boost predictedRelevance for suggestions clustered
    near winnable tracked terms.
  • \`maxReachChance\` 0-100: < 20 = skip; ≥ 40 = good slot.

Use the table as the empirical anchor:
  • If neighbouring tracked terms show high volume + LOW difficulty —
    propose adjacent long-tail / synonym keywords that exploit the
    same pocket. Cite the evidence in \`rationale\`
    ("anchor term 'X' has volume 4200 with difficulty 18 — this
    long-tail rides the same intent cluster").
  • If neighbouring tracked terms show high difficulty + low chance —
    AVOID more hero terms in that pocket; propose long-tail escape
    routes instead.
  • NEVER invent third-party numbers for keywords NOT in the table.

═══════════════════════════════════════════════════════════════════════
RANKING + REASONING
═══════════════════════════════════════════════════════════════════════
For each suggestion:
  1. Rank predictedRelevance 0-100. Use the FULL range — vanity
     suggestions should score 30-50, only true painkiller fits 90+.
     When the performance table is present, factor in the difficulty
     and maxReachChance of NEIGHBOURING tracked terms in the same
     intent cluster.
  2. rationale: 1-2 plain English sentences referencing THIS app's
     genre / mechanic / audience. When the performance table is
     present, cite the specific anchor row that justifies the score
     ("rides the same intent as 'X' which has difficulty 0.22").
  3. Prefer 1-3 word phrases. Multi-word long-tail is fine when the
     phrase has real query intent.

Quality target: 25 candidates means ~5 must-target, ~10 strong, ~10
test-worthy. Filter your own list — don't fill quota with weak terms.
`.trim();

export function buildKeywordSuggestTask(
  input: KeywordSuggestInput,
): AiTask<KeywordSuggestInput, KeywordSuggestOutput> {
  const userPrompt = renderUserPrompt(input);
  return {
    kind: "keyword.suggest",
    input,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // KeywordSuggestion.bucket uses `z.preprocess` to normalise the
    // AI's richer cluster vocabulary into the canonical 5-value enum.
    // That makes input ≠ output at the type level, which the AiTask's
    // tight `ZodSchema<TOutput>` doesn't accept. Cast it — the runtime
    // shape after parse matches KeywordSuggestOutput exactly.
    outputSchema: KeywordSuggestOutput as unknown as ZodSchema<KeywordSuggestOutput>,
    jsonSchema: KEYWORD_SUGGEST_JSON_SCHEMA as unknown as Record<string, unknown>,
    taskName: "submit_keyword_suggestions",
    taskDescription:
      "Return the final list of candidate App Store keywords for the publisher to review.",
    maxOutputTokens: 2048,
    temperature: 0.4,
  };
}

function renderUserPrompt(input: KeywordSuggestInput): string {
  const lines: string[] = [];
  lines.push(`App: ${input.appName}`);
  lines.push(`Primary locale: ${input.primaryLocale}`);
  if (input.territories.length > 0) {
    lines.push(`Territories of interest: ${input.territories.join(", ")}`);
  }
  if (input.primaryGenre) lines.push(`Primary genre: ${input.primaryGenre}`);
  if (input.shortDescription) {
    lines.push("");
    lines.push(`Short description:\n${input.shortDescription.trim()}`);
  }
  if (input.longDescription) {
    lines.push("");
    lines.push(
      `Long description (truncated to 2000 chars):\n${input.longDescription.trim().slice(0, 2000)}`,
    );
  }
  if (input.existingKeywords.length > 0) {
    lines.push("");
    lines.push(
      `Already tracked (do NOT duplicate, but they are useful context):\n${input.existingKeywords
        .map((k) => `  - ${k}`)
        .join("\n")}`,
    );
  }

  if (input.performanceContext && input.performanceContext.length > 0) {
    const top = input.performanceContext.slice(0, 30);
    const hasResearch = top.some(
      (k) =>
        k.volume != null || k.maxVolume != null || k.difficulty != null || k.maxReachChance != null,
    );
    lines.push("");
    lines.push("# Live keyword performance (top tracked terms for this storefront)");
    if (hasResearch) {
      lines.push(
        "keyword | score (0..1) | App Store rank | bucket | volume (0-100) | maxVol | difficulty (0-100) | maxReachChance (0-100)",
      );
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.score?.toFixed(2) ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"} | ${k.volume ?? "—"} | ${k.maxVolume ?? "—"} | ${k.difficulty ?? "—"} | ${k.maxReachChance ?? "—"}`,
        );
      }
      lines.push("");
      lines.push(
        "These rows are the EMPIRICAL anchor. Propose suggestions that ride winnable pockets (low difficulty + high maxReachChance) and cite the anchor term in `rationale`.",
      );
    } else {
      lines.push("keyword | score (0..1) | App Store rank | bucket");
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.score?.toFixed(2) ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"}`,
        );
      }
      lines.push("");
      lines.push(
        "Note: third-party signals (volume / difficulty / maxReachChance) are not connected. Rank on relevance + painkiller fit only — do NOT invent numeric estimates.",
      );
    }
  }

  lines.push("");
  lines.push(
    `Return exactly ${input.count.toString()} candidate keywords across CORE / LONG_TAIL / SYNONYM / COMPETITOR_BORROW buckets.`,
  );
  return lines.join("\n");
}
