/**
 * Adopted-vs-default performance summariser — pure function.
 *
 * Once a tenant starts swapping default metadata keywords for Astro
 * suggestions (tags=["adopted"]), the question becomes "are the swaps
 * paying off?". This helper compares the AVERAGE current rank of the
 * adopted set against the default set and surfaces a single number
 * the UI / analyst can lean on:
 *
 *   • adoptedCount + defaultCount
 *   • adoptedAvgRank vs defaultAvgRank (lower = better)
 *   • adoptedListed vs defaultListed (rate of being on-list at all)
 *   • verdict: "winning" | "behind" | "even" | "insufficient"
 *
 * Pure, deterministic, no DB — caller supplies the snapshot. Used
 * both by the daily-check widget and by the analyst prompt input
 * (so the AI commentary can mention swap success).
 */

export interface AdoptedPerformanceInput {
  /** Each tracked keyword's latest rank + tag set. Rank is null when
   *  off-list. Off-list rows count toward `*Total` but not `*AvgRank`. */
  rows: {
    trackedKeywordId: string;
    rankToday: number | null;
    tags: string[];
  }[];
}

export type AdoptedVerdict = "winning" | "behind" | "even" | "insufficient";

export interface AdoptedPerformanceSummary {
  adoptedTotal: number;
  defaultTotal: number;
  /** Count of rows that have a numeric rank today (i.e. are ON the
   *  list). */
  adoptedListed: number;
  defaultListed: number;
  /** Average current rank — only computed over `*Listed`. Lower is
   *  better. Null when no listed rows. */
  adoptedAvgRank: number | null;
  defaultAvgRank: number | null;
  /** adoptedAvg − defaultAvg. Negative = adopted is better (lower
   *  rank number). Null when either side has no data. */
  rankDelta: number | null;
  verdict: AdoptedVerdict;
}

const MIN_PER_SIDE_FOR_VERDICT = 3;

/**
 * Run the comparison. Pure: same rows in → same summary out.
 */
export function summariseAdoptedPerformance(
  input: AdoptedPerformanceInput,
): AdoptedPerformanceSummary {
  let adoptedListed = 0;
  let defaultListed = 0;
  let adoptedTotal = 0;
  let defaultTotal = 0;
  let adoptedSum = 0;
  let defaultSum = 0;

  for (const row of input.rows) {
    const tags = row.tags.map((t) => t.toLowerCase());
    const isAdopted = tags.includes("adopted");
    const isDefault = tags.includes("default");
    if (isAdopted) {
      adoptedTotal += 1;
      if (row.rankToday != null) {
        adoptedListed += 1;
        adoptedSum += row.rankToday;
      }
    }
    // Note: a keyword can be BOTH adopted + default in edge cases
    // (e.g. a swap brought back something originally in the
    // metadata). For the rate comparison we still count it in both
    // buckets — small overlap doesn't distort the headline number.
    if (isDefault) {
      defaultTotal += 1;
      if (row.rankToday != null) {
        defaultListed += 1;
        defaultSum += row.rankToday;
      }
    }
  }

  const adoptedAvgRank = adoptedListed > 0 ? adoptedSum / adoptedListed : null;
  const defaultAvgRank = defaultListed > 0 ? defaultSum / defaultListed : null;

  let rankDelta: number | null = null;
  let verdict: AdoptedVerdict = "insufficient";

  if (
    adoptedAvgRank != null &&
    defaultAvgRank != null &&
    adoptedListed >= MIN_PER_SIDE_FOR_VERDICT &&
    defaultListed >= MIN_PER_SIDE_FOR_VERDICT
  ) {
    rankDelta = adoptedAvgRank - defaultAvgRank;
    // ≤ −2 rank positions = adopted is meaningfully better.
    if (rankDelta <= -2) verdict = "winning";
    else if (rankDelta >= 2) verdict = "behind";
    else verdict = "even";
  }

  return {
    adoptedTotal,
    defaultTotal,
    adoptedListed,
    defaultListed,
    adoptedAvgRank,
    defaultAvgRank,
    rankDelta,
    verdict,
  };
}
