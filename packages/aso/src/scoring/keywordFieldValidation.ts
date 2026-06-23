/**
 * iOS Keywords Field validation engine.
 *
 * Apple's keywords field has subtle indexing rules that most apps
 * violate, wasting characters on tokens that don't earn any
 * additional indexing weight. This module enforces those rules as
 * pure functions so the UI can surface warnings inline next to each
 * keyword chip — and Astro Autopilot can suppress proposals that
 * would just create more waste.
 *
 * Rules implemented (in priority order of audit severity):
 *
 *   1. **Title / Subtitle overlap** — Apple indexes title + subtitle
 *      words automatically. Repeating them in the keywords field is
 *      wasted bytes that earn zero additional rank weight.
 *      Severity: amber (waste) · Pro standard: enforce.
 *
 *   2. **App name overlap** — same logic but for the app name itself
 *      (which Apple weighs even higher than the title field).
 *      Severity: amber.
 *
 *   3. **Plural / singular dedup** — Apple auto-matches `game` ↔
 *      `games`, `puzzle` ↔ `puzzles`. Having both wastes bytes.
 *      Severity: amber.
 *
 *   4. **Stop words** — `the`, `a`, `an`, `and`, `or`, `of`, `for`,
 *      `in`, `on`, `at`, `to`, `with`. Apple's tokenizer skips these.
 *      Severity: amber.
 *
 *   5. **Multi-word redundancy** — when both component words exist
 *      separately in the field, Apple auto-combines them
 *      (per documented combinatorial indexing). E.g. having `block`
 *      + `breaker` + `block breaker` is 12 chars wasted.
 *      Severity: amber.
 *
 *   6. **Special-character drag** — `&`, `'`, `+`, `/`, `()`, `[]`
 *      can reduce searchability per Apple-developer-forum guidance.
 *      Severity: blue (info).
 *
 *   7. **Numbers** — digits in keywords field dilute search weight
 *      (Apple doesn't index numeric variants well unless the search
 *      query is also numeric).
 *      Severity: blue (info).
 *
 *   8. **Known-trademarked competitor patterns** — `candy crush`,
 *      `subway surfers`, `royal match`, etc. Apple drops infringing
 *      keywords AND it's a legal risk (rejection / trademark claims).
 *      Severity: red (legal).
 *
 *   9. **Length cap** — single token over 30 chars almost certainly
 *      a copy-paste error.
 *      Severity: red.
 *
 *  10. **Empty / too short** — `<3` chars rarely earn indexing
 *      (single letters, two-letter abbreviations).
 *      Severity: amber.
 *
 * Pure functions only — UI consumes the returned `Warning[]` and
 * decorates chips; Astro Autopilot uses the same engine to suppress
 * waste-prone proposals.
 */

/** Severity of a warning, used by UI to colour-code chips. */
export type ValidationSeverity = "info" | "warning" | "danger";

/** A single validation warning attached to one keyword token. */
export interface KeywordWarning {
  /** Stable code so callers can filter / aggregate. */
  code:
    | "TITLE_OVERLAP"
    | "APP_NAME_OVERLAP"
    | "SUBTITLE_OVERLAP"
    | "PLURAL_DUPLICATE"
    | "STOP_WORD"
    | "MULTI_WORD_REDUNDANT"
    | "SPECIAL_CHAR"
    | "NUMERIC_DRAG"
    | "TRADEMARK_RISK"
    | "TOO_LONG"
    | "TOO_SHORT";
  severity: ValidationSeverity;
  /** Short plain-English message — surface verbatim in the UI. */
  message: string;
  /** Bytes that would be saved by dropping this token. UI uses for
   *  the aggregate "23 chars could be freed" footer. */
  charsSaved: number;
}

/** Context passed to the validator — typically pulled from the
 *  current AppLocalization row + a static list of well-known
 *  trademarked competitor names. */
export interface KeywordValidationContext {
  /** App name (full name from store config — heaviest indexing weight). */
  appName?: string | null;
  /** Title field for the active locale. */
  title?: string | null;
  /** Subtitle field for the active locale (iOS only). */
  subtitle?: string | null;
  /** All OTHER tokens currently in the keywords field. Excludes the
   *  token being validated. Order doesn't matter. */
  otherKeywords?: string[];
  /** Whether to apply trademark-risk checks. Default true. */
  checkTrademarks?: boolean;
}

/** Stop words Apple's tokenizer strips. Lowercase. English-focused —
 *  the metadata editor is locale-aware so this isn't exhaustive, but
 *  these are the most-commonly-wasted tokens we see in audits. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "with",
  "by",
  "from",
  "as",
  "is",
  "are",
  "be",
]);

/** Well-known trademarked competitor patterns. Conservative list —
 *  only games + apps with active trademark enforcement history.
 *  Substring match (case-insensitive). */
const TRADEMARK_PATTERNS: readonly string[] = [
  "candy crush",
  "subway surfers",
  "royal match",
  "coin master",
  "clash royale",
  "clash of clans",
  "brawl stars",
  "pokemon",
  "pokémon",
  "monopoly",
  "tetris",
  "minecraft",
  "roblox",
  "fortnite",
  "instagram",
  "tiktok",
  "snapchat",
  "whatsapp",
  "spotify",
  "netflix",
];

/** Special characters Apple discourages in the keywords field. */
const SPECIAL_CHAR_RE = /[&'+/()[\]"]/;

/** Compute the canonical singular form of a token for plural-dedup
 *  detection. Conservative — only handles the most common English
 *  plural endings. Returns the input lowercased when no rule fires. */
function canonicalSingular(token: string): string {
  const lc = token.toLowerCase().trim();
  // -ies → -y (e.g. "puzzles" stays "puzzle", but "stories" → "story")
  if (lc.length > 3 && lc.endsWith("ies")) return lc.slice(0, -3) + "y";
  // -es → drop (boxes → box, watches → watch)
  if (
    lc.length > 3 &&
    (lc.endsWith("xes") || lc.endsWith("ses") || lc.endsWith("ches") || lc.endsWith("shes"))
  ) {
    return lc.slice(0, -2);
  }
  // generic -s
  if (lc.length > 2 && lc.endsWith("s") && !lc.endsWith("ss")) return lc.slice(0, -1);
  return lc;
}

/** Token bag of all words appearing across other slots (app name +
 *  title + subtitle). Lowercased, deduped. Used for overlap checks. */
function buildSlotTokenSet(
  ctx: KeywordValidationContext,
): Map<string, Set<"appName" | "title" | "subtitle">> {
  const out = new Map<string, Set<"appName" | "title" | "subtitle">>();
  const push = (raw: string | null | undefined, source: "appName" | "title" | "subtitle"): void => {
    if (!raw) return;
    for (const word of raw
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean)) {
      const cleaned = word.replace(/[^\p{Letter}\p{Number}]/gu, "");
      if (cleaned.length < 2) continue;
      const set = out.get(cleaned) ?? new Set();
      set.add(source);
      out.set(cleaned, set);
    }
  };
  push(ctx.appName, "appName");
  push(ctx.title, "title");
  push(ctx.subtitle, "subtitle");
  return out;
}

/**
 * Validate a single keyword token against the rules above. Returns
 * an array of warnings (empty when the token is clean). Each
 * warning lists the bytes saved by dropping the token, which the UI
 * aggregates for the "X chars could be freed" footer.
 *
 * The bytes-saved is the token length PLUS one for the comma
 * separator, because in a keywords field of N tokens we save
 * `token.length + 1` when we remove a token (we collapse the comma
 * that joined it to its neighbour).
 */
export function validateKeywordToken(
  token: string,
  ctx: KeywordValidationContext = {},
): KeywordWarning[] {
  const warnings: KeywordWarning[] = [];
  const trimmed = token.trim();
  if (trimmed.length === 0) return warnings;
  const lc = trimmed.toLowerCase();
  const lengthCost = trimmed.length + 1; // +1 for joining comma
  const words = lc.split(/\s+/).filter(Boolean);

  // 1. Length-too-short
  if (trimmed.length < 3) {
    warnings.push({
      code: "TOO_SHORT",
      severity: "warning",
      message: "Under 3 characters — almost never indexed.",
      charsSaved: lengthCost,
    });
  }
  // 9. Length-too-long
  if (trimmed.length > 30) {
    warnings.push({
      code: "TOO_LONG",
      severity: "danger",
      message: "Single token over 30 characters — likely a copy-paste error.",
      charsSaved: lengthCost,
    });
  }

  // 4. Stop words (only flag pure stop-word tokens, not phrases)
  if (words.length === 1 && STOP_WORDS.has(lc)) {
    warnings.push({
      code: "STOP_WORD",
      severity: "warning",
      message: `Apple's tokenizer skips stop words ("${lc}"). Drop to free ${lengthCost.toString()} chars.`,
      charsSaved: lengthCost,
    });
  }

  // 6. Special chars
  if (SPECIAL_CHAR_RE.test(trimmed)) {
    warnings.push({
      code: "SPECIAL_CHAR",
      severity: "info",
      message: "Special characters (& ' + / etc.) can reduce searchability.",
      charsSaved: 0, // info-only — caller may keep it
    });
  }

  // 7. Numeric drag (digits make up >40% of the token)
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  if (digitCount > 0 && digitCount / trimmed.length > 0.4) {
    warnings.push({
      code: "NUMERIC_DRAG",
      severity: "info",
      message: "Digit-heavy tokens dilute search weight; only worth it for SKU / model searches.",
      charsSaved: 0,
    });
  }

  // 8. Trademark-risk
  if (ctx.checkTrademarks !== false) {
    for (const pattern of TRADEMARK_PATTERNS) {
      if (lc.includes(pattern)) {
        warnings.push({
          code: "TRADEMARK_RISK",
          severity: "danger",
          message: `Contains trademarked competitor name "${pattern}" — Apple drops it AND legal risk. Drop immediately.`,
          charsSaved: lengthCost,
        });
        break;
      }
    }
  }

  // 1+2+3. Slot overlap (app name / title / subtitle)
  const slotTokens = buildSlotTokenSet(ctx);
  for (const word of words) {
    const sources = slotTokens.get(word);
    if (!sources) continue;
    if (sources.has("appName")) {
      warnings.push({
        code: "APP_NAME_OVERLAP",
        severity: "warning",
        message: `"${word}" already in app name — Apple indexes it automatically at higher weight. Drop to free ${lengthCost.toString()} chars.`,
        charsSaved: lengthCost,
      });
      break;
    }
    if (sources.has("title")) {
      warnings.push({
        code: "TITLE_OVERLAP",
        severity: "warning",
        message: `"${word}" already in title — Apple indexes it automatically. Drop to free ${lengthCost.toString()} chars.`,
        charsSaved: lengthCost,
      });
      break;
    }
    if (sources.has("subtitle")) {
      warnings.push({
        code: "SUBTITLE_OVERLAP",
        severity: "warning",
        message: `"${word}" already in subtitle — Apple indexes it automatically. Drop to free ${lengthCost.toString()} chars.`,
        charsSaved: lengthCost,
      });
      break;
    }
  }

  // 3. Plural duplicate — only meaningful when otherKeywords is provided
  const others = (ctx.otherKeywords ?? []).map((o) => o.toLowerCase().trim());
  if (others.length > 0) {
    const myCanonical = canonicalSingular(lc);
    for (const other of others) {
      if (other === lc) continue;
      if (canonicalSingular(other) === myCanonical) {
        warnings.push({
          code: "PLURAL_DUPLICATE",
          severity: "warning",
          message: `Apple auto-matches singular/plural — "${lc}" and "${other}" cover the same search index. Drop one to free ${lengthCost.toString()} chars.`,
          charsSaved: lengthCost,
        });
        break;
      }
    }
  }

  // 5. Multi-word redundancy — for a multi-word token, if BOTH
  // component words exist as separate tokens in otherKeywords,
  // Apple auto-combines them and this multi-word entry adds nothing.
  if (words.length >= 2 && others.length > 0) {
    const allWordsPresent = words.every((w) => others.some((o) => o.split(/\s+/).includes(w)));
    if (allWordsPresent) {
      warnings.push({
        code: "MULTI_WORD_REDUNDANT",
        severity: "warning",
        message: `All words of "${lc}" already exist separately — Apple auto-combines them. Drop to free ${lengthCost.toString()} chars.`,
        charsSaved: lengthCost,
      });
    }
  }

  return warnings;
}

/**
 * Validate an entire comma-separated keywords field. Calls
 * `validateKeywordToken` for each token with full peer context, then
 * aggregates total chars-saved + worst severity. Used by the UI's
 * Slot Allocation Planner footer and by Astro Autopilot's filter
 * pipeline.
 */
export function validateKeywordsField(
  keywordsField: string,
  ctx: Omit<KeywordValidationContext, "otherKeywords"> = {},
): {
  tokens: { token: string; warnings: KeywordWarning[] }[];
  totalCharsSaved: number;
  worstSeverity: ValidationSeverity | null;
} {
  const tokens = keywordsField
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const results = tokens.map((token, idx) => {
    const otherKeywords = tokens.filter((_, i) => i !== idx);
    return {
      token,
      warnings: validateKeywordToken(token, { ...ctx, otherKeywords }),
    };
  });

  const totalCharsSaved = results.reduce(
    (sum, r) => sum + r.warnings.reduce((s, w) => s + w.charsSaved, 0),
    0,
  );
  let worstSeverity: ValidationSeverity | null = null;
  for (const r of results) {
    for (const w of r.warnings) {
      if (w.severity === "danger")
        return { tokens: results, totalCharsSaved, worstSeverity: "danger" };
      if (w.severity === "warning") worstSeverity = "warning";
      if (worstSeverity == null && w.severity === "info") worstSeverity = "info";
    }
  }
  return { tokens: results, totalCharsSaved, worstSeverity };
}
