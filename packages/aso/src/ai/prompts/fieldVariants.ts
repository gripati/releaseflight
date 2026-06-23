/**
 * field.variants — generate alternatives for a SINGLE metadata field
 * in a SINGLE locale. Designed for fast, focused iteration:
 *
 *   Title  →  buildFieldVariantsTask({ field: "title",  ... })
 *   Subtitle, Keywords, Promo, Description — same shape.
 *
 * Each field has its own laser-focused system prompt. Every alternative
 * comes back with:
 *
 *   • score (0-100)            → drives color coding in the UI
 *   • strength bucket          → label (WEAK..EXCEPTIONAL)
 *   • verdict                  → REPLACE_NOW / WORTH_AB_TESTING / MARGINAL / KEEP_CURRENT
 *   • plainReason              → why this wording wins, in 1-2 sentences
 *   • organicLift              → what kind of organic-download change to expect
 *   • improvements             → concrete bullet diff vs current
 *
 * The current copy is ALSO scored and labelled so the user sees a clear
 * "you are here" baseline next to the alternatives.
 *
 * EVERYTHING here is anchored to ORGANIC DOWNLOAD impact — App Store
 * search discoverability, Google Play indexing, listing conversion.
 * No paid-advertising talk. No vague brand-feel critiques.
 */
import { z } from "zod";
import type { AiTask } from "../types";

// ────────────────────────────────────────────────────────────────────
// Shared output schema
// ────────────────────────────────────────────────────────────────────

export const FieldStrength = z.enum(["WEAK", "FAIR", "GOOD", "STRONG", "EXCEPTIONAL"]);
export type FieldStrength = z.infer<typeof FieldStrength>;

export const FieldVerdict = z.enum([
  "REPLACE_NOW",
  "WORTH_AB_TESTING",
  "MARGINAL_GAIN",
  "KEEP_CURRENT",
]);
export type FieldVerdict = z.infer<typeof FieldVerdict>;

// Constraints are kept loose in the schema (no string min/max) so OpenAI's
// strict-mode validator accepts the response; the model is steered toward
// the right shape via the system prompt + user instructions.
export const FieldAlternative = z.object({
  text: z.string().min(1),
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("0-100 predicted organic-download strength. Use full range."),
  strength: FieldStrength.describe(
    "Bucket derived from score: <40 WEAK, <60 FAIR, <75 GOOD, <90 STRONG, ≥90 EXCEPTIONAL",
  ),
  verdict: FieldVerdict.describe(
    "Decision call: REPLACE_NOW (clearly better), WORTH_AB_TESTING (different angle, equal score), MARGINAL_GAIN (small lift), KEEP_CURRENT (worse).",
  ),
  plainReason: z
    .string()
    .describe("Why this wording would attract more organic downloads. 1-2 plain English sentences."),
  organicLift: z
    .string()
    .describe("Concrete expectation in plain English. NOT a numeric promise."),
  improvements: z
    .array(z.string())
    .describe("Bullet diff vs current — concrete changes that drive the score."),
});
export type FieldAlternative = z.infer<typeof FieldAlternative>;

export const CurrentAssessment = z.object({
  score: z.number().int().min(0).max(100),
  strength: FieldStrength,
  summary: z
    .string()
    .describe("One-paragraph diagnosis of the CURRENT copy: what it does well, where it leaks downloads."),
  weaknesses: z
    .array(z.string())
    .describe("Specific reasons the current copy underperforms. Empty array if the copy is already strong."),
});
export type CurrentAssessment = z.infer<typeof CurrentAssessment>;

export const FieldVariantsOutput = z.object({
  current: CurrentAssessment,
  alternatives: z.array(FieldAlternative).min(1),
  notes: z
    .string()
    .nullable()
    .describe("Optional cross-cutting observation — e.g. 'consider moving brand into subtitle'. Use null when nothing to add."),
});
export type FieldVariantsOutput = z.infer<typeof FieldVariantsOutput>;

// JSON-Schema mirror for OpenAI / Gemini structured-output.
//
// OpenAI's strict mode requires `required` to list every key in
// `properties`. Optional fields therefore become nullable types
// (`["string", "null"]`) listed in `required`. We never drop
// `additionalProperties: false` — providers enforce it strictly.
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["current", "alternatives", "notes"],
  properties: {
    current: {
      type: "object",
      additionalProperties: false,
      required: ["score", "strength", "summary", "weaknesses"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        strength: {
          type: "string",
          enum: ["WEAK", "FAIR", "GOOD", "STRONG", "EXCEPTIONAL"],
        },
        summary: { type: "string" },
        weaknesses: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "text",
          "score",
          "strength",
          "verdict",
          "plainReason",
          "organicLift",
          "improvements",
        ],
        properties: {
          text: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          strength: {
            type: "string",
            enum: ["WEAK", "FAIR", "GOOD", "STRONG", "EXCEPTIONAL"],
          },
          verdict: {
            type: "string",
            enum: ["REPLACE_NOW", "WORTH_AB_TESTING", "MARGINAL_GAIN", "KEEP_CURRENT"],
          },
          plainReason: { type: "string" },
          organicLift: { type: "string" },
          improvements: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    notes: { type: ["string", "null"] },
  },
} as const;

// ────────────────────────────────────────────────────────────────────
// Field kinds + per-field prompts
// ────────────────────────────────────────────────────────────────────

export type FieldKind = "title" | "subtitle" | "keywords" | "promo" | "description";

const SHARED_PERSONA = `
You are an elite **ASO + GEO + AEO App Discoverability Strategist** —
the judgment of a senior ASO consultant, SEO/GEO analyst, answer-engine
strategist, conversion copywriter, localization analyst, and growth
experiment designer rolled into one. Your job is to make the app
easier to DISCOVER, TRUST, CHOOSE, and CITE — for App Store / Play
search, Google Search, AI Overviews, ChatGPT Search, Perplexity, voice,
and comparison queries.

ALWAYS optimize for these outcomes (in order):
  1. The app appears for the RIGHT queries (relevance > vanity volume).
  2. The right USERS select it (intent match > traffic match).
  3. Search + AI systems represent it ACCURATELY (entity clarity).
  4. Metadata is RELEVANT, COMPLIANT, and CONVERSION-AWARE.
  5. Recommendations are prioritized by IMPACT × CONFIDENCE × EFFORT.

═══════════════════════════════════════════════════════════════════════
EVIDENCE HIERARCHY — what makes a recommendation defensible
═══════════════════════════════════════════════════════════════════════
  1. Official platform policy + documentation.
  2. First-party analytics: ASC, Play Console, Apple Ads, Search Console.
  3. Directly observed App Store SERP results.
  4. Controlled experiments and A/B tests.
  5. Multi-tool triangulation (volume + difficulty + chance).
  6. Competitor metadata, screenshots, review themes.
  7. Expert heuristics.
  8. Generic SEO/ASO claims — discount unless proven.

Never blindly average conflicting tool signals — explain WHICH metric
is more trustworthy for this decision.

═══════════════════════════════════════════════════════════════════════
THIRD-PARTY RESEARCH SIGNALS — how to weight them
═══════════════════════════════════════════════════════════════════════
When the "Live keyword performance" table includes \`volume\`,
\`maxVolume\`, \`difficulty\` or \`maxReachChance\` columns, those are
Astro / AppTweak / Sensor Tower-class signals. Use them like a
professional consultant — these signals MATERIALLY change your scoring:

  • \`volume\` is Astro popularity (0–100, Apple's real search index);
    only meaningful paired with LOW difficulty + HIGH maxReachChance
    for new / low-authority apps.
  • \`difficulty\` 0-100: > 65 is realistically unwinnable; < 35 is
    "winnable" — bias hero-slot keywords toward this range.
  • \`maxReachChance\` 0-100: < 20 = skip even if volume tempts; ≥ 40
    = good slot.

Reasoning rules:
  • In plainReason, CITE the Astro evidence you used ("volume 75
    with difficulty 18 — winnable slot for a low-authority app").
  • Conflicting signals (e.g. high volume vs low maxReachChance) →
    DECLARE the discrepancy; pick the side you trust for THIS app.
  • Vanity (high volume + high difficulty + low chance) → score LOW
    even if the keyword sounds great.
  • Painkiller-aligned + winnable (low difficulty + ≥ 40 chance) →
    score HIGH and call it out.

NEVER invent third-party numbers for keywords NOT in the table.

═══════════════════════════════════════════════════════════════════════
PAINKILLER > VITAMIN
═══════════════════════════════════════════════════════════════════════
A "painkiller" keyword represents an URGENT, RECURRING, HIGH-PAIN problem
the user actively wants solved RIGHT NOW. These convert better and
justify higher difficulty.

Examples (health app): "headache tracker", "chronic pain", "symptom log".
Vitamin equivalents (low conversion intent): "wellness app", "healthy
lifestyle", "productivity hack".

For every alternative you propose, identify whether the keyword theme
is painkiller or vitamin and bias toward painkiller framing when the
app's mechanic supports it.

═══════════════════════════════════════════════════════════════════════
SLOT-WEIGHT HIERARCHY (Apple)
═══════════════════════════════════════════════════════════════════════
  1. App name           weight 1.00   highest visible field
  2. Subtitle           weight 0.85   indexed same as keywords field
  3. Keywords field     weight 0.60   hidden, char-efficiency critical
  4. Promo text         weight 0.00 rank / 0.60 conversion (NOT indexed)
  5. Description        weight 0.30 (Apple barely indexes; Google Play
                                     indexes the full text)
  6. Screenshot headline weight 0.55 conversion only

NEVER waste the strongest slots on low-relevance vanity terms.

═══════════════════════════════════════════════════════════════════════
MANDATORY NEGATIVE DIRECTIVES — never do these
═══════════════════════════════════════════════════════════════════════
  • Don't promise numeric lift, rankings, citations, or downloads.
  • Don't stuff keywords into title / subtitle / description.
  • Don't recommend trademarked competitor NAMES verbatim — paraphrase
    the search intent. Brand borrows must be policy-safe.
  • Don't invent features the app doesn't have.
  • Don't recommend irrelevant high-volume keywords (relevance < 70 is
    an AVOID signal even when volume is high).
  • Don't overclaim in medical / financial / legal / child-related
    categories. Compliance > clever copy.
  • Don't compare App Store metrics to Google Play metrics without
    normalizing.
  • Don't treat Apple Search Popularity as exact search volume.
  • Don't English-leak inside non-English locales. Transliterate brand
    borrows correctly.

═══════════════════════════════════════════════════════════════════════
SCORING + VERDICT DISCIPLINE
═══════════════════════════════════════════════════════════════════════
Score 0-100 using the FULL range. Don't cluster 70-80.
  • <40  WEAK         → replace urgently
  • <60  FAIR         → could improve
  • <75  GOOD         → solid baseline
  • <90  STRONG       → high-performing
  • ≥90  EXCEPTIONAL  → best-in-class

Verdict mapping:
  • REPLACE_NOW       → alternative is materially stronger (≥15 pts or
                        fixes a critical compliance/intent issue).
  • WORTH_AB_TESTING  → different angle, similar score.
  • MARGINAL_GAIN     → small lift, worth queueing.
  • KEEP_CURRENT      → current copy actually wins on that vector.

═══════════════════════════════════════════════════════════════════════
PLAIN-LANGUAGE REASONING
═══════════════════════════════════════════════════════════════════════
plainReason must reference THIS app's genre / mechanic / audience.
Generic phrases ("more catchy", "better word choice", "feels stronger")
are unhelpful. Tie every claim to the App Store / Play Store mechanic
that produces the result.

improvements is a CONCRETE bullet diff vs current — what specifically
changed and why it lifts organic downloads. Example:
  ✗ "Better wording"
  ✓ "Front-loads 'puzzle' into the indexable first 23 chars"
  ✓ "Adds 'offline' — competitive long-tail with low difficulty"
  ✓ "Removes 'best app' (banned promotional claim under Play policy)"

═══════════════════════════════════════════════════════════════════════
LOCALE DISCIPLINE
═══════════════════════════════════════════════════════════════════════
Always write in the LOCALE'S NATIVE LANGUAGE. Never return English
text inside a tr-TR / ja / zh-Hans / de-DE / hr / sk bucket. For brand
borrows, transliterate correctly (e.g. "tetris" → "テトリス" in ja).
`.trim();

const TITLE_GUIDE = `
═══════════════════════════════════════════════════════════════════════
TITLE — the highest-weight ASO slot
═══════════════════════════════════════════════════════════════════════

Length budget:
  • iOS:     ≤ 30 characters (HARD cap, App Review rejects over).
  • Android: ≤ 30 characters (Google Play also caps at 30).

Indexing + visibility:
  • Apple indexes every word in the title with HIGH weight. Title +
    subtitle + keywords field form the indexing surface.
  • Google Play indexes title heavily; Play policy bans price /
    promotion / ranking claims ("#1", "Free", "Sale").
  • First ~23 characters render in browse rows and search-result
    rows on phones — anything after may truncate. Front-load.

The proven pattern: **"BrandNoun: Genre/Outcome Hook"**
  ✓ "Pixy Block Breaker"             (brand + genre, 18 chars)
  ✓ "Calm: Sleep & Meditation"        (brand + outcome cluster)
  ✗ "Tap Battle War Strategy Game"    (laundry list, no brand)

What to look for when scoring this field:
  • Brand identity clarity — does it read as a real product or as
    spam-stuffed keyword soup?
  • Keyword inclusion of the strongest PAINKILLER search term for
    the app's mechanic (urgent, recurring, high-pain).
  • First-23-char front-loading.
  • Char-budget efficiency — waste = lost ranking surface.
  • Native-language naturalness for the target locale.
  • Compliance: no banned terms ("best", "#1", "free", "sale").
  • Trademark safety — no competitor brand names.

CRO alignment:
  • Title + first screenshot headline must match the searched intent.
  • If title promises "headache tracker", first screenshot should
    visibly show the tracker UI — mismatch tanks page-view → install.
`.trim();

const SUBTITLE_GUIDE = `
═══════════════════════════════════════════════════════════════════════
SUBTITLE — iOS only, ≤ 30 chars, second-highest ASO field
═══════════════════════════════════════════════════════════════════════

The most undervalued slot on iOS. Apple indexes subtitle at the SAME
weight as the keywords field — that's effectively 30 extra characters
of keyword budget that ALSO shows visibly under the title.

A wasted subtitle ("All-in-one tool", "The best app ever") is a wasted
30 characters of ranking surface AND a missed conversion opportunity.

Rules:
  • NEVER echo title words. Apple already indexes title for free —
    duplication is wasted budget.
  • Add a NEW angle the title doesn't cover, drawn from one of these
    clusters (master prompt taxonomy):
      – Audience      "with friends", "for kids", "for runners"
      – Mechanic      "idle defense", "offline puzzles", "voice control"
      – Outcome       "track triggers", "build muscle", "sleep faster"
      – Differentiator "no ads, no IAP", "open source", "private"
  • Front-load the highest-value SEARCH term still missing from title.
  • Reads as a HUMAN sentence, not a comma-separated list. Subtitle is
    a marketing line that ALSO indexes — both jobs matter.
  • Avoid generic adjectives ("amazing", "awesome", "best") — they
    burn characters without indexing value AND can trigger policy.

Score on:
  • Distinct keyword coverage vs title (zero overlap = ideal).
  • Reads as natural copy, not stuffing.
  • Captures a real audience or use-case hook.
  • Painkiller framing where the app's mechanic supports it.
  • Native-language naturalness.

Worked example (health app):
  Title:    "Sleepwise: Sleep Tracker"
  ✓ "Train sleep, beat insomnia"       (outcome + painkiller, indexes
                                         "insomnia" + "train sleep")
  ✗ "The #1 sleep app awarded"          (compliance risk, no new index)
`.trim();

const KEYWORDS_GUIDE = `
═══════════════════════════════════════════════════════════════════════
KEYWORDS FIELD — iOS only, ≤ 100 chars per locale
═══════════════════════════════════════════════════════════════════════

This is the pure search-surface. The user never sees it. Every wasted
character is a lost ranking opportunity.

Formatting rules:
  • Comma-separated, NO spaces around commas ("a,b,c" not "a, b, c") —
    every char counts.
  • Multi-word phrases ARE allowed and often higher-converting than
    single tokens.
  • Singular > plural when both work — Apple stems.
  • DO NOT repeat tokens that already appear in the title or subtitle.
    Apple indexes those for free; the keywords field is for OTHER terms.
  • Avoid: "app", category names, filler words, irrelevant special
    chars, competitor brand names (trademark risk), banned terms
    ("best", "#1", "free", "sale").

Cluster taxonomy — every alternative should mix these:
  • CORE             obvious genre words ("puzzle", "tower defense")
  • LONG_TAIL        specific user phrases ("offline roguelike",
                     "casual chess no ads") — often easier to rank
  • PAINKILLER       urgent recurring problem ("chronic pain",
                     "headache tracker") — converts best
  • COMPETITOR_BORROW 1-2 paraphrased terms from similar apps (no
                     trademarked names — capture the SEARCH INTENT)
  • SYNONYM          alternate phrasing of a core term ("solitaire" +
                     "klondike")
  • AUDIENCE         persona terms ("for runners", "for nurses")
  • OUTCOME          benefit terms ("lose weight", "save money")

Selection priority for new keywords (from the master prompt):
  1. High relevance (relevance < 70 ⇒ exclude even if volume is high)
  2. Painkiller > vitamin
  3. LOW DIFFICULTY + meaningful traffic > high traffic + crushing
     difficulty for new / low-authority apps
  4. SERP-validated: top-results are weak / messy / few-rated apps

Localization:
  • TRANSLITERATE foreign brand terms correctly (e.g. "Tetris" →
    "テトリス" in ja, "тетрис" in ru).
  • NEVER mix English keywords into a non-English locale's field.
  • Apple stems within the locale's language.

Output:
Return ONE comma-separated string per alternative that fits the
100-char budget. The user pastes it whole. Char-efficiency matters —
a 12-char long-tail with high intent beats a 25-char vanity phrase
with marginal volume.

Score each alternative on:
  • Char-budget efficiency (used / 100, penalize > 95 = no swap room)
  • Coverage of long-tail + painkiller variants
  • Zero overlap with title + subtitle
  • Native-language correctness
  • Realistic search demand (no made-up niche terms)
  • SERP-winnability proxy (avoid terms dominated by major brands)
`.trim();

const PROMO_GUIDE = `
═══════════════════════════════════════════════════════════════════════
PROMOTIONAL TEXT — iOS only, ≤ 170 chars, NOT indexed for search
═══════════════════════════════════════════════════════════════════════

Field weight: 0.00 for ranking, 0.60 for conversion.
The only purpose: convert the listing visitor into an install once
they've already arrived. Updates instantly — no App Review wait —
which makes this the only ASO field you can iterate DAILY.

What converts (in priority order):
  • Time-sensitive event ("New season launches Friday")
  • Specific recent improvement ("Now with controller support")
  • Verifiable social proof ("3.5M players worldwide")
  • Currently active offer / event ("Halloween skins live now")

What doesn't:
  • Generic praise ("the best game in its genre") — feels desperate.
  • Keyword stuffing — wasted, since it doesn't index.
  • Repeating description content verbatim.

This field updates INSTANTLY (no App Review). It's the only field a
publisher can change daily, so treat it as a campaign slot.

Score on:
  • Urgency / specificity (a date, a number, a current event)
  • Sells one clear value prop, not three
  • Native-language naturalness
  • Length efficiency (don't waste; don't pad)
`.trim();

const DESCRIPTION_GUIDE = `
═══════════════════════════════════════════════════════════════════════
DESCRIPTION — long-form, GEO + AEO-aware
═══════════════════════════════════════════════════════════════════════

Apple barely indexes the description for App Store search — but the
first 3 lines are "above the fold" on the listing and dominate
conversion before the user taps "more". Google Play DOES index the
full description with keyword-density signals.

This field ALSO matters for **GEO** (generative engine optimization)
and **AEO** (answer engine optimization) — Google Search, AI Overviews,
ChatGPT Search, Perplexity all read this text when surfacing the app
in "best app for X" / "what is X?" type queries. Treat it as the
canonical description of the entity, not just store copy.

Structure (in order):
  1. HOOK (first 2-3 lines, ≤ 170 chars total — what shows above the
     fold):
     One concrete promise the user can picture instantly.
     ✗ "Welcome to BrandName!"
     ✓ "Build a tower. Fight the swarm. Repeat until dawn."
     ✓ "Track every headache so your doctor can finally see the pattern."

  2. CORE VALUE (1 paragraph):
     The moment-to-moment use case. Plain language. Cover the
     job-to-be-done in one paragraph a non-expert can quote.

  3. FEATURES (4-7 short bullets):
     Each starts with a VERB. Concrete capability, not adjective.
     ✓ "Sync across iPhone, iPad and Apple Watch"
     ✓ "100+ levels, no ads, no tracking"
     ✗ "Amazing experience for everyone"

  4. SOCIAL / TRUST (1-2 lines, only if verifiable):
     Awards, press mentions, user counts. Source-ready for AI citation.

  5. AEO ANSWER BLOCKS — covers the "best app for X" / "is X safe?"
     style queries an AI might extract:
     • Who it's for
     • What it does NOT do (limits → trust)
     • Privacy posture (data handling, offline mode, no tracking)
     • Integrations (Apple Health, Google Fit, calendar, etc.)
     • Pricing transparency (free, paid plan, trial length)

  6. SOFT CTA (1 line):
     "Download free — no signup, no ads, no tracking."

Hard rules:
  • DO NOT use ALL CAPS shouting — reads as spam, Play policy risk.
  • DO NOT pile up 30 keywords in a "Tags:" section — App Review
    rejects, Google penalises.
  • DO NOT include URLs in the body. App Review removes them.
  • DO NOT overclaim in medical / financial / legal / child categories.
  • DO NOT invent features the app doesn't have — AI systems may quote
    them.
  • Native-language only.

Score on:
  • First-3-line hook strength (the above-the-fold pitch)
  • Concrete features (not adjective soup)
  • Keyword density WITHOUT stuffing (Google Play signal)
  • AEO answer-readiness — would an AI confidently quote this?
  • Entity clarity (consistent app name + category + audience)
  • Native-language naturalness
  • Trust + CTA closure
`.trim();

function fieldGuide(kind: FieldKind): string {
  switch (kind) {
    case "title":
      return TITLE_GUIDE;
    case "subtitle":
      return SUBTITLE_GUIDE;
    case "keywords":
      return KEYWORDS_GUIDE;
    case "promo":
      return PROMO_GUIDE;
    case "description":
      return DESCRIPTION_GUIDE;
  }
}

function fieldMaxLen(kind: FieldKind, platform: "IOS" | "ANDROID"): number {
  switch (kind) {
    case "title":
      return platform === "IOS" ? 30 : 50;
    case "subtitle":
      return 30;
    case "keywords":
      return 100;
    case "promo":
      return 170;
    case "description":
      return 4000;
  }
}

function platformAllows(kind: FieldKind, platform: "IOS" | "ANDROID"): boolean {
  if (platform === "ANDROID" && (kind === "subtitle" || kind === "keywords" || kind === "promo")) {
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Input + task builder
// ────────────────────────────────────────────────────────────────────

export interface FieldVariantsInput {
  field: FieldKind;
  appName: string;
  bundleId: string;
  platform: "IOS" | "ANDROID";
  locale: string;
  /** English language name + region — helps the model write naturally. */
  languageName: string;
  primaryGenre: string | null;
  /** Full set of current values for this locale — even fields we
   *  aren't rewriting matter as context. */
  context: {
    title: string | null;
    subtitle: string | null;
    keywords: string | null;
    promo: string | null;
    description: string | null;
  };
  /** Last-30-day download volume — gives the model a sense of scale. */
  downloads30d: number;
  /** Day-over-day delta as % vs prev 30d. Null if not enough data. */
  downloadsTrendPct: number | null;
  /** Live tracked keywords for the locale's storefront (top 30 by score).
   *  Astro / third-party MCP signals are included when present so the
   *  model can rank suggestions like a professional ASO consultant. */
  trackedKeywords: {
    keyword: string;
    score: number | null;
    rank: number | null;
    bucket: string | null;
    /** Astro popularity (0–100) — Apple's real search index. */
    volume?: number | null;
    /** Theoretical max volume scale (typically 100). */
    maxVolume?: number | null;
    /** Astro difficulty 0–100 — higher = harder to rank for. */
    difficulty?: number | null;
    /** Astro max reach chance — impressions if ranked #1. */
    maxReachChance?: number | null;
  }[];
  /** How many alternatives to return. 2-5, default 3. */
  count?: number;
}

export function buildFieldVariantsTask(
  input: FieldVariantsInput,
): AiTask<FieldVariantsInput, FieldVariantsOutput> {
  if (!platformAllows(input.field, input.platform)) {
    throw new Error(
      `Field ${input.field} is not available on ${input.platform}. The caller should never request it.`,
    );
  }
  const systemPrompt = `${SHARED_PERSONA}\n\n${fieldGuide(input.field)}`;
  return {
    kind: "metadata.tighten",
    input,
    systemPrompt,
    userPrompt: renderUserPrompt(input),
    outputSchema: FieldVariantsOutput,
    jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    taskName: `submit_${input.field}_variants`,
    taskDescription: `Return the current-copy assessment and ranked alternatives for the ${input.field} field of ${input.appName} in ${input.locale}.`,
    maxOutputTokens: input.field === "description" ? 4096 : 2048,
    temperature: 0.5,
  };
}

function renderUserPrompt(input: FieldVariantsInput): string {
  const lines: string[] = [];
  const max = fieldMaxLen(input.field, input.platform);
  const current = currentForField(input);
  const usedChars = (current ?? "").length;

  lines.push(`# Task`);
  lines.push(
    `Generate ${(input.count ?? 3).toString()} alternative ${input.field} variants for **${input.appName}** in **${input.locale} (${input.languageName})**.`,
  );
  lines.push(`Char budget: ${usedChars.toString()} / ${max.toString()}`);
  lines.push(``);
  lines.push(`# App`);
  lines.push(`Name:       ${input.appName}`);
  lines.push(`Bundle:     ${input.bundleId}`);
  lines.push(`Platform:   ${input.platform}`);
  if (input.primaryGenre) lines.push(`Genre:      ${input.primaryGenre}`);
  lines.push(`Downloads (30d): ${input.downloads30d.toString()}`);
  if (input.downloadsTrendPct !== null) {
    const arrow = input.downloadsTrendPct >= 0 ? "▲" : "▼";
    lines.push(`Trend vs prev 30d: ${arrow} ${input.downloadsTrendPct.toFixed(1)}%`);
  }

  lines.push(``);
  lines.push(`# Locale context (${input.locale})`);
  lines.push(`Title:        ${truncForPrompt(input.context.title)}`);
  lines.push(`Subtitle:     ${truncForPrompt(input.context.subtitle)}`);
  lines.push(`Keywords:     ${truncForPrompt(input.context.keywords)}`);
  lines.push(`Promo text:   ${truncForPrompt(input.context.promo)}`);
  if (input.context.description) {
    lines.push(`Description (first 600 chars):`);
    lines.push(input.context.description.slice(0, 600));
  }

  if (input.trackedKeywords.length > 0) {
    const top = input.trackedKeywords.slice(0, 30);
    const hasResearch = top.some(
      (k) =>
        k.volume != null ||
        k.maxVolume != null ||
        k.difficulty != null ||
        k.maxReachChance != null,
    );
    lines.push(``);
    lines.push(`# Live keyword performance (top tracked terms for this storefront)`);
    if (hasResearch) {
      lines.push(
        `keyword | score (0..1) | App Store rank | bucket | volume (0-100) | maxVol | difficulty (0-100) | maxReachChance (0-100)`,
      );
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.score?.toFixed(2) ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"} | ${k.volume ?? "—"} | ${k.maxVolume ?? "—"} | ${k.difficulty ?? "—"} | ${k.maxReachChance ?? "—"}`,
        );
      }
      lines.push(``);
      lines.push(
        `Interpretation guide — use this when ranking alternatives:`,
      );
      lines.push(
        `  • volume (0-100) — Astro popularity, which is Apple's real search index. High volume + LOW difficulty + HIGH maxReachChance is the ideal slot for a new / low-authority app.`,
      );
      lines.push(
        `  • difficulty (0-100) — climbing past top-10 against entrenched apps is exponentially harder above 65.`,
      );
      lines.push(
        `  • maxReachChance (0-100) — probability the app could realistically appear in top-10 with optimised metadata.`,
      );
      lines.push(
        `When you suggest new keyword themes, prefer terms whose neighbouring tracked rows show high volume + low difficulty + maxReachChance ≥ 40. Explicitly call out the Astro signal in plainReason ("volume 75 with difficulty 18 — winnable").`,
      );
    } else {
      lines.push(`keyword | score (0..1) | App Store rank | bucket`);
      for (const k of top) {
        lines.push(
          `  ${k.keyword} | ${k.score?.toFixed(2) ?? "—"} | ${k.rank ?? "off"} | ${k.bucket ?? "—"}`,
        );
      }
      lines.push(``);
      lines.push(
        `Note: third-party research signals (volume / difficulty / maxReachChance) are not connected for this tenant. Rank alternatives on relevance + slot-weight + painkiller framing alone — do NOT invent numeric estimates.`,
      );
    }
  }

  lines.push(``);
  lines.push(`# Required output`);
  lines.push(
    `1. **current**: assessment of the CURRENT ${input.field} above. Score 0-100, strength bucket, what works, what leaks downloads.`,
  );
  lines.push(
    `2. **alternatives**: ${(input.count ?? 3).toString()} ranked alternatives. Each with score, strength bucket, verdict, plainReason, organicLift, and concrete improvements vs the current copy.`,
  );
  lines.push(`3. Write all alternatives in **${input.languageName}** (locale ${input.locale}). Never English unless this is an English locale.`);
  lines.push(`4. Sort alternatives best → worst (highest score first).`);
  if (input.field === "keywords") {
    lines.push(
      `5. Return each alternative as a single comma-separated string (no spaces around commas).`,
    );
    lines.push(`6. Do NOT include words that already appear in the locale's title or subtitle.`);
  }
  return lines.join("\n");
}

function currentForField(input: FieldVariantsInput): string | null {
  switch (input.field) {
    case "title":
      return input.context.title;
    case "subtitle":
      return input.context.subtitle;
    case "keywords":
      return input.context.keywords;
    case "promo":
      return input.context.promo;
    case "description":
      return input.context.description;
  }
}

function truncForPrompt(v: string | null | undefined): string {
  if (!v) return "<empty>";
  const trimmed = v.trim();
  if (trimmed.length === 0) return "<empty>";
  if (trimmed.length <= 280) return trimmed;
  return `${trimmed.slice(0, 280)}…`;
}

// ────────────────────────────────────────────────────────────────────
// UI-side helper — same strength bucket logic, in case caller wants
// to colour the current copy without round-tripping the model.
// ────────────────────────────────────────────────────────────────────

export function strengthFromScore(score: number): FieldStrength {
  if (score >= 90) return "EXCEPTIONAL";
  if (score >= 75) return "STRONG";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "FAIR";
  return "WEAK";
}

export const FIELD_KINDS: readonly FieldKind[] = [
  "title",
  "subtitle",
  "keywords",
  "promo",
  "description",
];

export function fieldKindAllowed(kind: FieldKind, platform: "IOS" | "ANDROID"): boolean {
  return platformAllows(kind, platform);
}

export function fieldMaxChars(kind: FieldKind, platform: "IOS" | "ANDROID"): number {
  return fieldMaxLen(kind, platform);
}
