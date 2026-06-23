/**
 * Temporal bucket detection — RISING / FALLING.
 *
 * `keywordScore` only assigns 4 buckets from a single daily snapshot:
 * CHAMPION, OPPORTUNITY, NEUTRAL, DECAY. RISING and FALLING are
 * fundamentally DELTA-BASED — you can't know a keyword is "rising"
 * without comparing today to N days ago.
 *
 * This helper layers a temporal override on top of the daily bucket.
 * The worker calls it after writing today's KeywordSignal row, using
 * the last 7 days of score + rank history. Returns:
 *
 *   • "RISING"  — score climbed ≥ 0.15 over 7 days, OR rank improved
 *                 by 10+ positions (lower rank = better).
 *   • "FALLING" — score dropped ≥ 0.15, OR rank regressed by 10+.
 *   • null      — flat or insufficient history.
 *
 * A non-null result wins over the daily bucket EXCEPT when the daily
 * bucket is CHAMPION (a CHAMPION shouldn't be relabelled RISING — it's
 * already at the top) or DECAY (DECAY needs immediate attention; a
 * slowly-recovering DECAY shouldn't be hidden behind a RISING label).
 *
 * Used as the source of truth for the "RISING" / "FALLING" stamps on
 * the keyword chips + bucket filter pills in the UI.
 */

export interface HistoricalSignal {
  /** ISO date or YYYY-MM-DD — caller sorts ascending. */
  date: string;
  /** Composite 0..1 score. Null when scoring failed for that day. */
  score: number | null;
  /** App Store rank (1-indexed). Null when off-list (>50). */
  appStoreRank: number | null;
}

export type TemporalBucket = "RISING" | "FALLING";

/** Minimum history points required to compute a delta. With fewer we
 *  return null — no statement is better than a noisy statement. */
const MIN_HISTORY_DAYS = 3;

/** Score delta threshold for RISING / FALLING in absolute points. */
const SCORE_DELTA_THRESHOLD = 0.15;

/** Rank delta threshold (positions). Positive = rank improved
 *  (smaller rank number is better). */
const RANK_DELTA_THRESHOLD = 10;

/**
 * Compute the temporal bucket from a window of historical signals.
 * Window is typically the last 7 days (the worker pulls 7 rows).
 *
 * Algorithm:
 *   1. Drop nulls (failed-score days don't anchor a comparison).
 *   2. Pick the oldest non-null entry as the baseline.
 *   3. Pick the newest non-null entry as the current.
 *   4. Compute score delta + rank delta.
 *   5. Return whichever direction crossed its threshold (score takes
 *      precedence on ties since it's the composite signal).
 */
export function temporalBucket(
  window: HistoricalSignal[],
): TemporalBucket | null {
  if (window.length < MIN_HISTORY_DAYS) return null;

  // Sort defensively (caller may not have sorted)
  const sorted = [...window].sort((a, b) => a.date.localeCompare(b.date));

  const oldestScored = sorted.find((s) => s.score != null) ?? null;
  const newestScored = [...sorted].reverse().find((s) => s.score != null) ?? null;
  if (!oldestScored || !newestScored || oldestScored === newestScored) {
    return null;
  }

  const scoreDelta = (newestScored.score ?? 0) - (oldestScored.score ?? 0);
  if (scoreDelta >= SCORE_DELTA_THRESHOLD) return "RISING";
  if (scoreDelta <= -SCORE_DELTA_THRESHOLD) return "FALLING";

  // Score-flat? Check rank trajectory as a secondary signal — a
  // keyword whose composite score is unchanged but whose rank moved
  // from #25 → #8 is meaningfully rising on the visibility surface.
  const oldestRanked = sorted.find((s) => s.appStoreRank != null) ?? null;
  const newestRanked = [...sorted].reverse().find((s) => s.appStoreRank != null) ?? null;
  if (!oldestRanked || !newestRanked || oldestRanked === newestRanked) {
    return null;
  }
  const rankDelta = (oldestRanked.appStoreRank ?? 0) - (newestRanked.appStoreRank ?? 0);
  // Positive rankDelta = rank improved (e.g. 25 → 8 yields delta +17).
  if (rankDelta >= RANK_DELTA_THRESHOLD) return "RISING";
  if (rankDelta <= -RANK_DELTA_THRESHOLD) return "FALLING";

  return null;
}

/**
 * Apply the temporal bucket override on top of a daily bucket. Used
 * by the worker after computing today's KeywordSignal row.
 *
 * Rules:
 *   • CHAMPION + RISING  → CHAMPION (already at the top, don't
 *                           relabel — would hide the win)
 *   • CHAMPION + FALLING → FALLING  (the champion is slipping —
 *                           surface the warning loud)
 *   • DECAY              → DECAY    (DECAY is a "needs attention"
 *                           label; a slowly-recovering DECAY isn't
 *                           ready to be celebrated as RISING)
 *   • Anything else      → temporal bucket wins when present
 */
export function applyTemporalOverride(
  dailyBucket: string | null | undefined,
  temporal: TemporalBucket | null,
): string | null {
  if (!temporal) return dailyBucket ?? null;
  if (dailyBucket === "CHAMPION" && temporal === "RISING") return "CHAMPION";
  if (dailyBucket === "DECAY") return "DECAY";
  return temporal;
}
