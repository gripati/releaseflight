/**
 * ASO Alarm Evaluation Engine — pure functions.
 *
 * Daily-check job feeds each evaluator a TYPED snapshot of the day's
 * signals. The evaluator returns AlarmEvent[] — one event per
 * triggered rule — which the worker writes to AsoNotification. The
 * ASO Analyst AI then layers a plain-English interpretation on top.
 *
 * Every evaluator is:
 *   • Pure (no DB / network)
 *   • Deterministic (same input → same output)
 *   • Thresholdable (rule config is JSON, passed in)
 *   • Self-documenting (each event carries a human-readable message
 *     + machine-readable payload).
 *
 * This module is the heart of the proactive daily-check loop —
 * matches the workflow in `docs/aso-gunluk-is-akisi.md` sections 4-6
 * (Genel Performans Kontrolü → Keyword Rank Kontrolü → Rakip Analizi).
 */

import type { TemporalBucket } from "./temporalBucket";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type AlarmSeverity = "info" | "warning" | "danger";

export type AlarmKind =
  | "KEYWORD_RANK_DROP"
  | "KEYWORD_RANK_RISE"
  | "KEYWORD_RANK_EXIT"
  | "KEYWORD_RANK_ENTRY"
  | "COMPETITOR_INTRUSION"
  | "COMPETITOR_OVERTOOK_US"
  | "BUCKET_DEGRADATION"
  | "CONVERSION_DROP"
  | "RATING_DROP"
  | "REVIEW_SENTIMENT"
  | "NEW_OPPORTUNITY_KEYWORD";

/** A single triggered alarm. Worker creates an AsoNotification row
 *  from this — the kind drives the title template, severity drives
 *  the bell badge colour, payload carries the numbers. */
export interface AlarmEvent {
  kind: AlarmKind;
  severity: AlarmSeverity;
  /** Short headline shown in the bell. */
  title: string;
  /** 1-2 sentence plain-English message. */
  message: string;
  /** Machine-readable payload — exact numbers, ids, keyword text. */
  payload: Record<string, unknown>;
  /** Tracked keyword the alarm is about (when applicable). */
  trackedKeywordId?: string;
  /** Competitor the alarm is about (when applicable). */
  competitorId?: string;
}

/** Per-keyword today-vs-yesterday rank snapshot. */
export interface KeywordRankDelta {
  trackedKeywordId: string;
  keyword: string;
  territory: string;
  rankToday: number | null;
  rankYesterday: number | null;
  bucketToday: string | null;
  bucketYesterday: string | null;
  scoreToday: number | null;
  scoreYesterday: number | null;
  temporal: TemporalBucket | null;
  /** Tags from TrackedKeyword.tags — used to gate "own" vs "competitor"
   *  rules. Lowercased. */
  tags: string[];
}

/** Per-competitor rank on one of OUR tracked keywords. */
export interface CompetitorRankDelta {
  competitorId: string;
  competitorName: string;
  trackedKeywordId: string;
  keyword: string;
  rankToday: number | null;
  rankYesterday: number | null;
  /** OUR current rank on the same keyword — for "overtook us" check. */
  ourRankToday: number | null;
}

/** Conversion + funnel KPIs, today vs 7-day baseline. */
export interface ConversionDelta {
  cvrToday: number | null;
  cvrBaseline: number | null;
  impressionsToday: number;
  impressionsBaseline: number;
  downloadsToday: number;
  downloadsBaseline: number;
}

/** Rating delta today vs 7-day baseline. */
export interface RatingDelta {
  ratingToday: number | null;
  ratingBaseline: number | null;
  newLowStarReviews: number;
  newTotalReviews: number;
}

// ─────────────────────────────────────────────────────────────────────
// Threshold configuration
// ─────────────────────────────────────────────────────────────────────

/** Default thresholds — used when an AsoAlarm row's `threshold` JSON
 *  doesn't override them. Tuned for the workflow document's
 *  guidance (e.g. moving from rank 12→8 is materially more important
 *  than 80→60 — see section 6.2). */
export interface KeywordRankDropThreshold {
  /** Trigger when rank drops by ≥ this many positions in 24h. */
  positions: number;
  /** AND when the resulting rank is still inside this many — drops
   *  from rank 95 to 100 don't matter; rank 12 → 17 does. */
  relevantUpTo: number;
}

export interface KeywordRankRiseThreshold {
  /** Positive deltas that warrant celebration (also surface them so
   *  the analyst can recommend "double down here"). */
  positions: number;
  relevantUpTo: number;
}

export interface KeywordRankExitThreshold {
  /** Trigger when a keyword that WAS ranked at-or-better-than this
   *  rank yesterday falls off the list today. A champion (rank 3)
   *  disappearing is far more material than a long-tail term (rank 48)
   *  doing the same — but both are signals. */
  yesterdayUpTo: number;
}

export interface KeywordRankEntryThreshold {
  /** Trigger when a keyword that was OFF the list yesterday appears
   *  inside this rank today. Good news but worth surfacing so the
   *  analyst can recommend "double down here". */
  todayUpTo: number;
}

export interface CompetitorIntrusionThreshold {
  /** Top-N our keyword that we want to defend. Competitor entering
   *  this band is an alarm. */
  topNToProtect: number;
}

export interface BucketDegradationThreshold {
  /** Trigger when ≥ this many keywords moved to DECAY today. */
  minDecayCount: number;
}

export interface ConversionDropThreshold {
  /** Relative drop in CVR vs baseline, in percentage points. */
  pctDrop: number;
  /** Skip when fewer than this many impressions — small-sample
   *  noise. */
  minImpressions: number;
}

export interface RatingDropThreshold {
  /** Absolute drop in rating (stars). 0.2 = 4.6 → 4.4. */
  starsDrop: number;
}

export interface ReviewSentimentThreshold {
  /** Trigger when ≥ this many new low-star reviews today. */
  minNewLowStarReviews: number;
}

export interface NewOpportunityKeywordThreshold {
  /** Astro popularity floor for a discovered keyword to warrant a
   *  "you should be tracking this" alarm. */
  minPopularity: number;
}

export interface AlarmThresholds {
  KEYWORD_RANK_DROP: KeywordRankDropThreshold;
  KEYWORD_RANK_RISE: KeywordRankRiseThreshold;
  KEYWORD_RANK_EXIT: KeywordRankExitThreshold;
  KEYWORD_RANK_ENTRY: KeywordRankEntryThreshold;
  COMPETITOR_INTRUSION: CompetitorIntrusionThreshold;
  BUCKET_DEGRADATION: BucketDegradationThreshold;
  CONVERSION_DROP: ConversionDropThreshold;
  RATING_DROP: RatingDropThreshold;
  REVIEW_SENTIMENT: ReviewSentimentThreshold;
  NEW_OPPORTUNITY_KEYWORD: NewOpportunityKeywordThreshold;
}

/**
 * Default thresholds — tuned to fire on real-world Astro data, which
 * tends to have lots of churn in the top-100 and frequent rank
 * appearances/disappearances on long-tail terms.
 *
 * Tunings:
 *   • positions=3 (was 5) — captures the 12→8 / 14→10 moves Apple
 *     surfaces frequently. <3 is noise.
 *   • relevantUpTo=100 (was 50) — top-100 still produces traffic.
 *     Apple browse rows go ~100 deep on some genres.
 *   • exit yesterdayUpTo=50 — falling off the first 5 pages is what
 *     hurts; rank 80 → off-list rarely affects installs.
 *   • entry todayUpTo=50 — first-page appearance is the signal.
 */
export const DEFAULT_THRESHOLDS: AlarmThresholds = {
  KEYWORD_RANK_DROP: { positions: 3, relevantUpTo: 100 },
  KEYWORD_RANK_RISE: { positions: 3, relevantUpTo: 100 },
  KEYWORD_RANK_EXIT: { yesterdayUpTo: 50 },
  KEYWORD_RANK_ENTRY: { todayUpTo: 50 },
  COMPETITOR_INTRUSION: { topNToProtect: 10 },
  BUCKET_DEGRADATION: { minDecayCount: 3 },
  CONVERSION_DROP: { pctDrop: 10, minImpressions: 100 },
  RATING_DROP: { starsDrop: 0.2 },
  REVIEW_SENTIMENT: { minNewLowStarReviews: 3 },
  NEW_OPPORTUNITY_KEYWORD: { minPopularity: 50 },
};

// ─────────────────────────────────────────────────────────────────────
// Evaluators
// ─────────────────────────────────────────────────────────────────────

/**
 * Detect significant rank drops on OUR tracked keywords. Filters
 * to keywords inside the "relevant" rank band (default top-50) so
 * drops from rank 95 → 100 don't fire — that's noise, not signal.
 *
 * Rank-drop severity ladder:
 *   • top-3 drop ≥3 positions  → danger (we lost a champion slot)
 *   • top-10 drop ≥5 positions → warning
 *   • top-50 drop ≥10 positions → warning
 *   • otherwise                 → info
 */
export function evaluateKeywordRankDrop(
  deltas: KeywordRankDelta[],
  threshold: KeywordRankDropThreshold = DEFAULT_THRESHOLDS.KEYWORD_RANK_DROP,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  for (const d of deltas) {
    if (d.rankToday == null || d.rankYesterday == null) continue;
    const drop = d.rankToday - d.rankYesterday; // positive = got worse
    if (drop < threshold.positions) continue;
    if (d.rankYesterday > threshold.relevantUpTo) continue;
    const wasTop3 = d.rankYesterday <= 3;
    const wasTop10 = d.rankYesterday <= 10;
    const severity: AlarmSeverity = wasTop3
      ? "danger"
      : wasTop10
        ? "warning"
        : "info";
    events.push({
      kind: "KEYWORD_RANK_DROP",
      severity,
      title: `"${d.keyword}" fell ${drop.toString()} positions in ${d.territory}`,
      message: `Was #${d.rankYesterday.toString()}, now #${d.rankToday.toString()}. ${wasTop3 ? "Champion slot at risk — investigate today." : wasTop10 ? "First-page position lost — review metadata + competitor moves." : "Moderate drop — keep an eye on it."}`,
      payload: {
        keyword: d.keyword,
        territory: d.territory,
        rankYesterday: d.rankYesterday,
        rankToday: d.rankToday,
        drop,
        tags: d.tags,
      },
      trackedKeywordId: d.trackedKeywordId,
    });
  }
  return events;
}

/**
 * Detect significant rank rises — these are GOOD news, but worth
 * surfacing so the analyst can recommend "double down on this
 * keyword via screenshot copy / CPP / Apple Ads".
 *
 * Always severity=info (good news isn't an alarm, it's a signal).
 */
export function evaluateKeywordRankRise(
  deltas: KeywordRankDelta[],
  threshold: KeywordRankRiseThreshold = DEFAULT_THRESHOLDS.KEYWORD_RANK_RISE,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  for (const d of deltas) {
    if (d.rankToday == null || d.rankYesterday == null) continue;
    const rise = d.rankYesterday - d.rankToday; // positive = improved
    if (rise < threshold.positions) continue;
    if (d.rankToday > threshold.relevantUpTo) continue;
    const intoTop10 = d.rankToday <= 10 && d.rankYesterday > 10;
    const intoTop3 = d.rankToday <= 3 && d.rankYesterday > 3;
    events.push({
      kind: "KEYWORD_RANK_RISE",
      severity: "info",
      title: `"${d.keyword}" climbed ${rise.toString()} positions in ${d.territory}`,
      message: `Was #${d.rankYesterday.toString()}, now #${d.rankToday.toString()}.${intoTop3 ? " Entered top-3 — protect this slot." : intoTop10 ? " Entered top-10 — first-page traffic unlocked." : " Rising — consider reinforcing with metadata + CPP."}`,
      payload: {
        keyword: d.keyword,
        territory: d.territory,
        rankYesterday: d.rankYesterday,
        rankToday: d.rankToday,
        rise,
        intoTop10,
        intoTop3,
      },
      trackedKeywordId: d.trackedKeywordId,
    });
  }
  return events;
}

/**
 * Detect keywords that were ranked yesterday but DISAPPEARED today.
 * Distinct from a "drop" because losing the list entirely is more
 * severe than dropping N positions — and the engine's drop evaluator
 * skips rows with null ranks. This evaluator catches them.
 *
 * Severity ladder (by yesterday's rank):
 *   • top-3  → danger (champion slot lost)
 *   • top-10 → warning (first-page lost)
 *   • else   → info
 */
export function evaluateKeywordRankExit(
  deltas: KeywordRankDelta[],
  threshold: KeywordRankExitThreshold = DEFAULT_THRESHOLDS.KEYWORD_RANK_EXIT,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  for (const d of deltas) {
    // We need a known yesterday rank AND an unknown / null rank today.
    if (d.rankYesterday == null || d.rankToday != null) continue;
    if (d.rankYesterday > threshold.yesterdayUpTo) continue;
    const wasTop3 = d.rankYesterday <= 3;
    const wasTop10 = d.rankYesterday <= 10;
    const severity: AlarmSeverity = wasTop3
      ? "danger"
      : wasTop10
        ? "warning"
        : "info";
    events.push({
      kind: "KEYWORD_RANK_EXIT",
      severity,
      title: `"${d.keyword}" fell off the list in ${d.territory}`,
      message: `Was #${d.rankYesterday.toString()} yesterday, not ranked today.${wasTop3 ? " Champion slot lost — investigate metadata + competitor moves today." : wasTop10 ? " First-page exit — review recent changes." : ""}`,
      payload: {
        keyword: d.keyword,
        territory: d.territory,
        rankYesterday: d.rankYesterday,
        rankToday: null,
        tags: d.tags,
      },
      trackedKeywordId: d.trackedKeywordId,
    });
  }
  return events;
}

/**
 * Detect keywords that were OFF the list yesterday but APPEARED
 * today. Always info — good news worth surfacing for analyst
 * recommendations ("double down via metadata + CPP").
 */
export function evaluateKeywordRankEntry(
  deltas: KeywordRankDelta[],
  threshold: KeywordRankEntryThreshold = DEFAULT_THRESHOLDS.KEYWORD_RANK_ENTRY,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  for (const d of deltas) {
    // We need a null/missing rank yesterday AND a known rank today.
    if (d.rankYesterday != null || d.rankToday == null) continue;
    if (d.rankToday > threshold.todayUpTo) continue;
    const intoTop3 = d.rankToday <= 3;
    const intoTop10 = d.rankToday <= 10;
    events.push({
      kind: "KEYWORD_RANK_ENTRY",
      severity: "info",
      title: `"${d.keyword}" entered the list at #${d.rankToday.toString()}`,
      message: `Wasn't ranked yesterday, now #${d.rankToday.toString()} in ${d.territory}.${intoTop3 ? " Direct top-3 entry — verify with manual SERP, may signal an algorithm shift in your favour." : intoTop10 ? " First-page debut — reinforce with metadata + CPP." : " Rising — keep an eye on whether it sticks."}`,
      payload: {
        keyword: d.keyword,
        territory: d.territory,
        rankYesterday: null,
        rankToday: d.rankToday,
        intoTop10,
        intoTop3,
      },
      trackedKeywordId: d.trackedKeywordId,
    });
  }
  return events;
}

/**
 * Detect competitors entering our top-N keywords. This is the
 * INBOUND counterpart to Astro's outbound competitor mining — the
 * key audit gap that prompted this whole subsystem. A competitor
 * that just entered our top-10 on a high-value keyword is the most
 * actionable signal a daily check can surface.
 *
 * Severity ladder:
 *   • Competitor entered top-3 → danger
 *   • Competitor entered top-10 → warning
 *   • Competitor improved ≥10 positions within top-50 → info
 */
export function evaluateCompetitorIntrusion(
  deltas: CompetitorRankDelta[],
  threshold: CompetitorIntrusionThreshold = DEFAULT_THRESHOLDS.COMPETITOR_INTRUSION,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  for (const d of deltas) {
    if (d.rankToday == null) continue;
    const enteredProtectedBand =
      d.rankToday <= threshold.topNToProtect &&
      (d.rankYesterday == null || d.rankYesterday > threshold.topNToProtect);
    const overtookUs =
      d.ourRankToday != null && d.rankToday < d.ourRankToday;

    if (!enteredProtectedBand && !overtookUs) {
      // Still surface big climbs even when not crossing top-N — they
      // foreshadow future intrusions.
      if (
        d.rankYesterday != null &&
        d.rankToday < 50 &&
        d.rankYesterday - d.rankToday >= 10
      ) {
        events.push({
          kind: "COMPETITOR_INTRUSION",
          severity: "info",
          title: `${d.competitorName} climbing on "${d.keyword}"`,
          message: `Was #${d.rankYesterday.toString()}, now #${d.rankToday.toString()}. Trending toward your protected band — keep watching.`,
          payload: {
            keyword: d.keyword,
            competitorName: d.competitorName,
            rankYesterday: d.rankYesterday,
            rankToday: d.rankToday,
          },
          trackedKeywordId: d.trackedKeywordId,
          competitorId: d.competitorId,
        });
      }
      continue;
    }

    const top3 = d.rankToday <= 3;
    const top10 = d.rankToday <= 10;
    const severity: AlarmSeverity = top3
      ? "danger"
      : top10
        ? "warning"
        : "info";
    const action = overtookUs
      ? `Now ranks #${d.rankToday.toString()} vs your #${(d.ourRankToday ?? "—").toString()}. Counter-move: refresh metadata, run Astro re-analyze, consider Apple Ads on this term.`
      : `Entered your protected top-${threshold.topNToProtect.toString()}. Review their metadata + screenshot moves; consider Apple Ads defence.`;
    events.push({
      kind: overtookUs ? "COMPETITOR_OVERTOOK_US" : "COMPETITOR_INTRUSION",
      severity,
      title: overtookUs
        ? `${d.competitorName} overtook you on "${d.keyword}"`
        : `${d.competitorName} entered top-${threshold.topNToProtect.toString()} on "${d.keyword}"`,
      message: action,
      payload: {
        keyword: d.keyword,
        competitorName: d.competitorName,
        rankYesterday: d.rankYesterday,
        rankToday: d.rankToday,
        ourRankToday: d.ourRankToday,
        overtook: overtookUs,
      },
      trackedKeywordId: d.trackedKeywordId,
      competitorId: d.competitorId,
    });
  }
  return events;
}

/**
 * Detect bulk degradation — N or more keywords landed in DECAY today
 * that weren't in DECAY yesterday. Signals systemic issue (bad push,
 * algorithm change, sustained competitor pressure) rather than a
 * single-keyword problem.
 */
export function evaluateBucketDegradation(
  deltas: KeywordRankDelta[],
  threshold: BucketDegradationThreshold = DEFAULT_THRESHOLDS.BUCKET_DEGRADATION,
): AlarmEvent[] {
  const newDecays = deltas.filter(
    (d) => d.bucketToday === "DECAY" && d.bucketYesterday !== "DECAY",
  );
  if (newDecays.length < threshold.minDecayCount) return [];
  return [
    {
      kind: "BUCKET_DEGRADATION",
      severity: newDecays.length >= threshold.minDecayCount * 2 ? "danger" : "warning",
      title: `${newDecays.length.toString()} keywords entered DECAY today`,
      message: `Systemic signal — multiple keywords lost ranking together. Likely cause: bad metadata push, algorithm change, or sustained competitor pressure. Investigate before adding more keywords.`,
      payload: {
        count: newDecays.length,
        keywords: newDecays.slice(0, 10).map((d) => d.keyword),
      },
    },
  ];
}

/**
 * Detect Conversion Rate drops vs the 7-day baseline. Skips when
 * impressions are below threshold (small-sample noise).
 */
export function evaluateConversionDrop(
  delta: ConversionDelta,
  threshold: ConversionDropThreshold = DEFAULT_THRESHOLDS.CONVERSION_DROP,
): AlarmEvent[] {
  if (delta.impressionsToday < threshold.minImpressions) return [];
  if (delta.cvrToday == null || delta.cvrBaseline == null) return [];
  if (delta.cvrBaseline === 0) return [];
  const pctDrop = ((delta.cvrBaseline - delta.cvrToday) / delta.cvrBaseline) * 100;
  if (pctDrop < threshold.pctDrop) return [];
  const severity: AlarmSeverity = pctDrop >= threshold.pctDrop * 2 ? "danger" : "warning";
  return [
    {
      kind: "CONVERSION_DROP",
      severity,
      title: `Conversion rate fell ${pctDrop.toFixed(1)}% vs last 7 days`,
      message: `CVR ${delta.cvrBaseline.toFixed(2)}% → ${delta.cvrToday.toFixed(2)}%. Investigate: recent screenshot/icon change? new bad reviews? metadata push?`,
      payload: {
        cvrToday: delta.cvrToday,
        cvrBaseline: delta.cvrBaseline,
        pctDrop,
        impressionsToday: delta.impressionsToday,
      },
    },
  ];
}

/**
 * Detect rating drops + low-star review waves. Rating directly
 * affects conversion + Apple search ranking — drops require
 * immediate attention.
 */
export function evaluateRatingDrop(
  delta: RatingDelta,
  threshold: RatingDropThreshold = DEFAULT_THRESHOLDS.RATING_DROP,
): AlarmEvent[] {
  const events: AlarmEvent[] = [];
  if (delta.ratingToday != null && delta.ratingBaseline != null) {
    // Star ratings are displayed/stored to 2 decimals (e.g. App Store
    // shows 4.6, 4.4). Round the diff to the same precision so
    // floating-point noise (4.6 - 4.4 = 0.1999999…) doesn't mute a
    // legitimate 0.2-star drop alarm.
    const drop = Math.round((delta.ratingBaseline - delta.ratingToday) * 100) / 100;
    if (drop >= threshold.starsDrop) {
      events.push({
        kind: "RATING_DROP",
        severity: drop >= threshold.starsDrop * 2 ? "danger" : "warning",
        title: `Rating dropped ${drop.toFixed(2)} stars`,
        message: `${delta.ratingBaseline.toFixed(2)} → ${delta.ratingToday.toFixed(2)}. Critical — read new 1-star + 2-star reviews today, prioritise fixes.`,
        payload: {
          ratingYesterday: delta.ratingBaseline,
          ratingToday: delta.ratingToday,
          drop,
        },
      });
    }
  }
  return events;
}

/**
 * Detect waves of low-star reviews — even when the aggregate rating
 * hasn't moved yet, a sudden cluster of 1-2 star reviews foreshadows
 * a rating drop within days.
 */
export function evaluateReviewSentiment(
  delta: RatingDelta,
  threshold: ReviewSentimentThreshold = DEFAULT_THRESHOLDS.REVIEW_SENTIMENT,
): AlarmEvent[] {
  if (delta.newLowStarReviews < threshold.minNewLowStarReviews) return [];
  const severity: AlarmSeverity =
    delta.newLowStarReviews >= threshold.minNewLowStarReviews * 3
      ? "danger"
      : "warning";
  return [
    {
      kind: "REVIEW_SENTIMENT",
      severity,
      title: `${delta.newLowStarReviews.toString()} low-star reviews today`,
      message: `Unusual cluster — read them today to surface the common complaint. Often a release-regression signal that hasn't hit rating yet.`,
      payload: {
        newLowStarReviews: delta.newLowStarReviews,
        newTotalReviews: delta.newTotalReviews,
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Master evaluator
// ─────────────────────────────────────────────────────────────────────

export interface AlarmEvaluationInput {
  keywordDeltas: KeywordRankDelta[];
  competitorDeltas: CompetitorRankDelta[];
  conversion?: ConversionDelta;
  rating?: RatingDelta;
  /** Per-kind threshold overrides — merged onto DEFAULT_THRESHOLDS. */
  overrides?: Partial<AlarmThresholds>;
}

/**
 * Run every evaluator against a single app's daily snapshot. The
 * worker calls this once per app per day; the resulting AlarmEvent[]
 * is written to AsoNotification (dedup'd by alarm × app × date).
 */
export function evaluateAllAlarms(input: AlarmEvaluationInput): AlarmEvent[] {
  const t = mergeThresholds(input.overrides);
  const events: AlarmEvent[] = [];

  events.push(...evaluateKeywordRankDrop(input.keywordDeltas, t.KEYWORD_RANK_DROP));
  events.push(...evaluateKeywordRankRise(input.keywordDeltas, t.KEYWORD_RANK_RISE));
  events.push(...evaluateKeywordRankExit(input.keywordDeltas, t.KEYWORD_RANK_EXIT));
  events.push(...evaluateKeywordRankEntry(input.keywordDeltas, t.KEYWORD_RANK_ENTRY));
  events.push(...evaluateCompetitorIntrusion(input.competitorDeltas, t.COMPETITOR_INTRUSION));
  events.push(...evaluateBucketDegradation(input.keywordDeltas, t.BUCKET_DEGRADATION));
  if (input.conversion) {
    events.push(...evaluateConversionDrop(input.conversion, t.CONVERSION_DROP));
  }
  if (input.rating) {
    events.push(...evaluateRatingDrop(input.rating, t.RATING_DROP));
    events.push(...evaluateReviewSentiment(input.rating, t.REVIEW_SENTIMENT));
  }

  return events.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function mergeThresholds(overrides?: Partial<AlarmThresholds>): AlarmThresholds {
  if (!overrides) return DEFAULT_THRESHOLDS;
  return {
    KEYWORD_RANK_DROP: { ...DEFAULT_THRESHOLDS.KEYWORD_RANK_DROP, ...(overrides.KEYWORD_RANK_DROP ?? {}) },
    KEYWORD_RANK_RISE: { ...DEFAULT_THRESHOLDS.KEYWORD_RANK_RISE, ...(overrides.KEYWORD_RANK_RISE ?? {}) },
    KEYWORD_RANK_EXIT: { ...DEFAULT_THRESHOLDS.KEYWORD_RANK_EXIT, ...(overrides.KEYWORD_RANK_EXIT ?? {}) },
    KEYWORD_RANK_ENTRY: { ...DEFAULT_THRESHOLDS.KEYWORD_RANK_ENTRY, ...(overrides.KEYWORD_RANK_ENTRY ?? {}) },
    COMPETITOR_INTRUSION: { ...DEFAULT_THRESHOLDS.COMPETITOR_INTRUSION, ...(overrides.COMPETITOR_INTRUSION ?? {}) },
    BUCKET_DEGRADATION: { ...DEFAULT_THRESHOLDS.BUCKET_DEGRADATION, ...(overrides.BUCKET_DEGRADATION ?? {}) },
    CONVERSION_DROP: { ...DEFAULT_THRESHOLDS.CONVERSION_DROP, ...(overrides.CONVERSION_DROP ?? {}) },
    RATING_DROP: { ...DEFAULT_THRESHOLDS.RATING_DROP, ...(overrides.RATING_DROP ?? {}) },
    REVIEW_SENTIMENT: { ...DEFAULT_THRESHOLDS.REVIEW_SENTIMENT, ...(overrides.REVIEW_SENTIMENT ?? {}) },
    NEW_OPPORTUNITY_KEYWORD: { ...DEFAULT_THRESHOLDS.NEW_OPPORTUNITY_KEYWORD, ...(overrides.NEW_OPPORTUNITY_KEYWORD ?? {}) },
  };
}

function severityRank(s: AlarmSeverity): number {
  return s === "danger" ? 3 : s === "warning" ? 2 : 1;
}
