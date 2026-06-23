/**
 * Pure swap engine for Astro autopilot.
 *
 * Given the current 100-char keywords field + a list of (weak → strong)
 * pairs, return:
 *   • the new field string
 *   • how many pairs were actually applied
 *   • a per-pair status code for the UI explainer
 *
 * Rules (in order):
 *
 *   1. If `strongKeyword` is already in the field → status "duplicate".
 *      Skip — never introduce duplicate tokens.
 *
 *   2. If `weakKeyword` is non-null and matches an in-field token
 *      (case-insensitive, exact token match) → replace in place.
 *      Status "replaced". Order preserved.
 *
 *   3. If `weakKeyword` is non-null but NOT in the field → append the
 *      strong token. Status "weak-missing-appended". (We optimistically
 *      add the upgrade since the user asked for it.)
 *
 *   4. If `weakKeyword` is null → append. Status "added".
 *
 *   5. Cap enforcement: when joined with commas the field must fit
 *      within 100 chars. Tokens appended in step 3/4 are placed at the
 *      FRONT of the field (high-value first); on overflow we drop from
 *      the END. Any newly-appended strong token that gets trimmed flips
 *      to status "skipped-cap".
 */
export const MAX_KEYWORDS_FIELD_CHARS = 100;

/** Tokenise an Apple keywords field (comma-separated, trimmed). Same
 *  contract as `parseKeywordsField` in keywordsFromMetadata.ts — kept
 *  inline so this module stays Prisma-free and test-importable from
 *  vitest without a live database. */
function parseKeywordsField(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export interface SwapPair {
  weakKeyword: string | null;
  strongKeyword: string;
}

export type SwapStatus =
  | "replaced"
  | "added"
  | "weak-missing-appended"
  | "duplicate"
  | "skipped-cap";

export interface ApplyResult {
  before: string;
  after: string;
  applied: number;
  appliedKeywords: Set<string>;
  pairResults: { weakKeyword: string | null; strongKeyword: string; status: SwapStatus }[];
}

export function applyAstroSwaps(
  currentField: string,
  pairs: SwapPair[],
): ApplyResult {
  const before = currentField;
  const tokens = parseKeywordsField(currentField);
  const lowerIndex = new Map<string, number>();
  tokens.forEach((t, i) => lowerIndex.set(t.toLowerCase(), i));

  let applied = 0;
  const appliedKeywords = new Set<string>();
  const pairResults: ApplyResult["pairResults"] = [];
  const appendQueue: string[] = [];

  for (const p of pairs) {
    const strongLower = p.strongKeyword.toLowerCase();
    if (lowerIndex.has(strongLower)) {
      pairResults.push({
        weakKeyword: p.weakKeyword,
        strongKeyword: p.strongKeyword,
        status: "duplicate",
      });
      continue;
    }

    if (p.weakKeyword) {
      const weakLower = p.weakKeyword.toLowerCase();
      const idx = lowerIndex.get(weakLower);
      if (idx !== undefined) {
        tokens[idx] = p.strongKeyword;
        lowerIndex.delete(weakLower);
        lowerIndex.set(strongLower, idx);
        applied += 1;
        appliedKeywords.add(strongLower);
        pairResults.push({
          weakKeyword: p.weakKeyword,
          strongKeyword: p.strongKeyword,
          status: "replaced",
        });
        continue;
      }
      pairResults.push({
        weakKeyword: p.weakKeyword,
        strongKeyword: p.strongKeyword,
        status: "weak-missing-appended",
      });
    } else {
      pairResults.push({
        weakKeyword: null,
        strongKeyword: p.strongKeyword,
        status: "added",
      });
    }
    appendQueue.push(p.strongKeyword);
    lowerIndex.set(strongLower, tokens.length + appendQueue.length - 1);
  }

  // Compose with appended (high-value) tokens at the front, then trim
  // from end for cap.
  const composed = [...appendQueue, ...tokens];
  for (const a of appendQueue) {
    applied += 1;
    appliedKeywords.add(a.toLowerCase());
  }

  // Pack tokens into the 100-char budget. We KEEP packing past a
  // single oversized token — that token gets skipped (and flagged
  // below) while smaller tokens further in the queue still get a
  // chance. This way an overlong strong-append doesn't accidentally
  // evict the existing field's tail.
  const final: string[] = [];
  let chars = 0;
  for (const t of composed) {
    const added = (final.length === 0 ? 0 : 1) + t.length;
    if (chars + added > MAX_KEYWORDS_FIELD_CHARS) continue;
    final.push(t);
    chars += added;
  }
  const after = final.join(",");

  // Mark trimmed strong appends as "skipped-cap".
  for (const a of appendQueue) {
    if (!final.includes(a)) {
      const idx = pairResults.findIndex(
        (r) =>
          r.strongKeyword === a &&
          (r.status === "added" || r.status === "weak-missing-appended"),
      );
      if (idx >= 0 && pairResults[idx]) {
        pairResults[idx].status = "skipped-cap";
        appliedKeywords.delete(a.toLowerCase());
        applied -= 1;
      }
    }
  }

  return { before, after, applied, appliedKeywords, pairResults };
}
