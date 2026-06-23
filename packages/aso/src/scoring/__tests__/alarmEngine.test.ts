import { describe, expect, test } from "vitest";
import {
  evaluateAllAlarms,
  evaluateBucketDegradation,
  evaluateCompetitorIntrusion,
  evaluateConversionDrop,
  evaluateKeywordRankDrop,
  evaluateKeywordRankEntry,
  evaluateKeywordRankExit,
  evaluateKeywordRankRise,
  evaluateRatingDrop,
  evaluateReviewSentiment,
  type CompetitorRankDelta,
  type ConversionDelta,
  type KeywordRankDelta,
  type RatingDelta,
} from "../alarmEngine";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers — keep the test bodies readable.
// ─────────────────────────────────────────────────────────────────────

function kw(
  partial: Partial<KeywordRankDelta> = {},
): KeywordRankDelta {
  return {
    trackedKeywordId: "tk_1",
    keyword: "merge puzzle",
    territory: "US",
    rankToday: 10,
    rankYesterday: 10,
    bucketToday: null,
    bucketYesterday: null,
    scoreToday: null,
    scoreYesterday: null,
    temporal: null,
    tags: ["own"],
    ...partial,
  };
}

function comp(
  partial: Partial<CompetitorRankDelta> = {},
): CompetitorRankDelta {
  return {
    competitorId: "c_1",
    competitorName: "Rival Inc",
    trackedKeywordId: "tk_1",
    keyword: "merge puzzle",
    rankToday: 15,
    rankYesterday: 30,
    ourRankToday: 8,
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────
// evaluateKeywordRankDrop
// ─────────────────────────────────────────────────────────────────────

describe("evaluateKeywordRankDrop", () => {
  test("emits danger when a top-3 keyword falls ≥5 positions", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: 2, rankToday: 9 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("danger");
    expect(events[0]!.kind).toBe("KEYWORD_RANK_DROP");
    expect(events[0]!.payload).toMatchObject({ drop: 7, rankYesterday: 2, rankToday: 9 });
    expect(events[0]!.trackedKeywordId).toBe("tk_1");
  });

  test("emits warning when a top-10 (not top-3) keyword falls ≥5 positions", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: 7, rankToday: 14 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
  });

  test("emits info when drop is inside relevant band but outside top-10", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: 20, rankToday: 28 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
  });

  test("ignores drops below the position threshold", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: 10, rankToday: 12 }), // only 2 positions, under default 3
    ]);
    expect(events).toEqual([]);
  });

  test("ignores drops that start outside the relevant band (rank 105 → 130 is noise)", () => {
    const events = evaluateKeywordRankDrop([
      // Yesterday > relevantUpTo (100) — buried-on-buried doesn't matter.
      kw({ rankYesterday: 105, rankToday: 130 }),
    ]);
    expect(events).toEqual([]);
  });

  test("ignores rows with null rank values (no comparable signal)", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: null, rankToday: 8 }),
      kw({ rankYesterday: 8, rankToday: null }),
    ]);
    expect(events).toEqual([]);
  });

  test("ignores rank IMPROVEMENTS (negative drop)", () => {
    const events = evaluateKeywordRankDrop([
      kw({ rankYesterday: 20, rankToday: 5 }),
    ]);
    expect(events).toEqual([]);
  });

  test("honours threshold overrides", () => {
    const events = evaluateKeywordRankDrop(
      // 2-position drop — under default but exceeds override threshold of 1.
      [kw({ rankYesterday: 10, rankToday: 12 })],
      { positions: 1, relevantUpTo: 50 },
    );
    expect(events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateKeywordRankRise
// ─────────────────────────────────────────────────────────────────────

describe("evaluateKeywordRankRise", () => {
  test("emits info when a keyword climbs ≥5 positions into a relevant band", () => {
    const events = evaluateKeywordRankRise([
      kw({ rankYesterday: 18, rankToday: 9 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.payload).toMatchObject({ rise: 9, intoTop10: true, intoTop3: false });
  });

  test("flags top-3 entry in payload", () => {
    const events = evaluateKeywordRankRise([
      kw({ rankYesterday: 12, rankToday: 2 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ intoTop3: true, intoTop10: true });
    expect(events[0]!.message).toContain("top-3");
  });

  test("ignores small rises", () => {
    const events = evaluateKeywordRankRise([
      kw({ rankYesterday: 10, rankToday: 8 }), // 2-position rise, under default 3
    ]);
    expect(events).toEqual([]);
  });

  test("ignores rises landing outside the relevant band", () => {
    // 170 → 120 is a big climb but still buried (top-100 is the cap) —
    // not a signal worth raising.
    const events = evaluateKeywordRankRise([
      kw({ rankYesterday: 170, rankToday: 120 }),
    ]);
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateKeywordRankExit — falling off the list entirely
// ─────────────────────────────────────────────────────────────────────

describe("evaluateKeywordRankExit", () => {
  test("danger when a top-3 keyword disappears", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: 2, rankToday: null }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("danger");
    expect(events[0]!.kind).toBe("KEYWORD_RANK_EXIT");
    expect(events[0]!.payload).toMatchObject({ rankYesterday: 2, rankToday: null });
  });

  test("warning when a top-10 (not top-3) keyword disappears", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: 7, rankToday: null }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
  });

  test("info when a top-50 long-tail keyword disappears", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: 42, rankToday: null }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
  });

  test("ignores exits from keywords already buried yesterday (rank > 50)", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: 78, rankToday: null }),
    ]);
    expect(events).toEqual([]);
  });

  test("does not fire when the keyword is still ranked today", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: 5, rankToday: 8 }),
    ]);
    expect(events).toEqual([]);
  });

  test("does not fire when there's no yesterday signal to compare", () => {
    const events = evaluateKeywordRankExit([
      kw({ rankYesterday: null, rankToday: null }),
    ]);
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateKeywordRankEntry — appearing in the list for the first time
// ─────────────────────────────────────────────────────────────────────

describe("evaluateKeywordRankEntry", () => {
  test("info when a keyword enters the list", () => {
    const events = evaluateKeywordRankEntry([
      kw({ rankYesterday: null, rankToday: 25 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.kind).toBe("KEYWORD_RANK_ENTRY");
  });

  test("flags top-3 entry in the payload + message", () => {
    const events = evaluateKeywordRankEntry([
      kw({ rankYesterday: null, rankToday: 2 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ intoTop3: true, intoTop10: true });
    expect(events[0]!.message).toContain("top-3");
  });

  test("flags top-10 entry in the payload", () => {
    const events = evaluateKeywordRankEntry([
      kw({ rankYesterday: null, rankToday: 9 }),
    ]);
    expect(events[0]!.payload).toMatchObject({ intoTop10: true, intoTop3: false });
  });

  test("ignores entries landing outside the relevant band", () => {
    const events = evaluateKeywordRankEntry([
      kw({ rankYesterday: null, rankToday: 72 }), // > default 50
    ]);
    expect(events).toEqual([]);
  });

  test("does not fire when the keyword was ranked yesterday too", () => {
    const events = evaluateKeywordRankEntry([
      kw({ rankYesterday: 30, rankToday: 18 }),
    ]);
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateCompetitorIntrusion
// ─────────────────────────────────────────────────────────────────────

describe("evaluateCompetitorIntrusion", () => {
  test("danger when competitor enters our protected top-3", () => {
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: 15, rankToday: 2, ourRankToday: 8 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("danger");
    // top-3 + below our rank → overtook
    expect(events[0]!.kind).toBe("COMPETITOR_OVERTOOK_US");
  });

  test("warning when competitor enters protected top-10 from outside", () => {
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: 20, rankToday: 9, ourRankToday: 4 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
    expect(events[0]!.kind).toBe("COMPETITOR_INTRUSION");
  });

  test("COMPETITOR_OVERTOOK_US even when entry isn't a fresh top-N crossing", () => {
    // Competitor was already in top-10 yesterday (#9) → not a fresh
    // intrusion, but they jumped past us today.
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: 9, rankToday: 5, ourRankToday: 7 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("COMPETITOR_OVERTOOK_US");
    expect(events[0]!.payload).toMatchObject({ overtook: true });
  });

  test("emits info-level climb signal when competitor is climbing but hasn't crossed top-N", () => {
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: 40, rankToday: 25, ourRankToday: 6 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.message.toLowerCase()).toContain("trending");
  });

  test("ignores small competitor movements outside the protected band", () => {
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: 45, rankToday: 40, ourRankToday: 6 }),
    ]);
    expect(events).toEqual([]);
  });

  test("ignores rows with null rankToday", () => {
    const events = evaluateCompetitorIntrusion([
      comp({ rankToday: null, rankYesterday: 5 }),
    ]);
    expect(events).toEqual([]);
  });

  test("rankYesterday=null on a fresh top-N appearance counts as intrusion", () => {
    // No history yesterday + showing up at #6 today = brand-new entry.
    const events = evaluateCompetitorIntrusion([
      comp({ rankYesterday: null, rankToday: 6, ourRankToday: 4 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("COMPETITOR_INTRUSION");
  });

  test("honours topNToProtect override", () => {
    const events = evaluateCompetitorIntrusion(
      [comp({ rankYesterday: 8, rankToday: 4, ourRankToday: 2 })],
      { topNToProtect: 3 },
    );
    // Top-3 protected band; competitor at #4 didn't enter top-3, but
    // they did overtake us (we're at #2, they're at #4 → no overtake
    // since 4 > 2). So this should be empty.
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateBucketDegradation
// ─────────────────────────────────────────────────────────────────────

describe("evaluateBucketDegradation", () => {
  test("fires warning when ≥3 keywords entered DECAY today", () => {
    const events = evaluateBucketDegradation([
      kw({ keyword: "a", bucketYesterday: "STABLE", bucketToday: "DECAY" }),
      kw({ keyword: "b", bucketYesterday: "RISING", bucketToday: "DECAY" }),
      kw({ keyword: "c", bucketYesterday: "STABLE", bucketToday: "DECAY" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
    expect(events[0]!.payload).toMatchObject({ count: 3 });
  });

  test("escalates to danger when count is ≥2x the threshold", () => {
    const decays = Array.from({ length: 6 }, (_, i) =>
      kw({ keyword: `kw${i.toString()}`, bucketYesterday: "STABLE", bucketToday: "DECAY" }),
    );
    const events = evaluateBucketDegradation(decays);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("danger");
  });

  test("does not fire when fewer than threshold keywords entered DECAY", () => {
    const events = evaluateBucketDegradation([
      kw({ bucketYesterday: "STABLE", bucketToday: "DECAY" }),
      kw({ bucketYesterday: "STABLE", bucketToday: "DECAY" }),
    ]);
    expect(events).toEqual([]);
  });

  test("ignores keywords that were ALREADY in DECAY yesterday (not new)", () => {
    const events = evaluateBucketDegradation([
      kw({ bucketYesterday: "DECAY", bucketToday: "DECAY" }),
      kw({ bucketYesterday: "DECAY", bucketToday: "DECAY" }),
      kw({ bucketYesterday: "DECAY", bucketToday: "DECAY" }),
    ]);
    expect(events).toEqual([]);
  });

  test("preserves the first 10 keyword names in the payload for the analyst", () => {
    const decays = Array.from({ length: 15 }, (_, i) =>
      kw({ keyword: `kw${i.toString()}`, bucketYesterday: "STABLE", bucketToday: "DECAY" }),
    );
    const events = evaluateBucketDegradation(decays);
    expect((events[0]!.payload.keywords as string[]).length).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateConversionDrop
// ─────────────────────────────────────────────────────────────────────

describe("evaluateConversionDrop", () => {
  test("fires warning when CVR drops ≥10% vs baseline", () => {
    const delta: ConversionDelta = {
      cvrBaseline: 5,
      cvrToday: 4.4, // 12% drop
      impressionsToday: 500,
      impressionsBaseline: 500,
      downloadsToday: 22,
      downloadsBaseline: 25,
    };
    const events = evaluateConversionDrop(delta);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
    expect((events[0]!.payload.pctDrop as number)).toBeGreaterThan(10);
  });

  test("escalates to danger when CVR drops ≥2x threshold", () => {
    const delta: ConversionDelta = {
      cvrBaseline: 5,
      cvrToday: 3, // 40% drop
      impressionsToday: 500,
      impressionsBaseline: 500,
      downloadsToday: 15,
      downloadsBaseline: 25,
    };
    const events = evaluateConversionDrop(delta);
    expect(events[0]!.severity).toBe("danger");
  });

  test("skips when impressions are below the small-sample floor", () => {
    const delta: ConversionDelta = {
      cvrBaseline: 5,
      cvrToday: 2,
      impressionsToday: 50, // < 100
      impressionsBaseline: 50,
      downloadsToday: 1,
      downloadsBaseline: 3,
    };
    expect(evaluateConversionDrop(delta)).toEqual([]);
  });

  test("skips when baseline is zero (no signal to compare against)", () => {
    const delta: ConversionDelta = {
      cvrBaseline: 0,
      cvrToday: 0,
      impressionsToday: 500,
      impressionsBaseline: 500,
      downloadsToday: 0,
      downloadsBaseline: 0,
    };
    expect(evaluateConversionDrop(delta)).toEqual([]);
  });

  test("skips when either CVR is null", () => {
    const events = evaluateConversionDrop({
      cvrBaseline: null,
      cvrToday: 4,
      impressionsToday: 500,
      impressionsBaseline: 500,
      downloadsToday: 20,
      downloadsBaseline: 20,
    });
    expect(events).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateRatingDrop
// ─────────────────────────────────────────────────────────────────────

describe("evaluateRatingDrop", () => {
  test("fires warning when rating drops ≥0.2 stars", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.6,
      ratingToday: 4.4,
      newLowStarReviews: 0,
      newTotalReviews: 0,
    };
    const events = evaluateRatingDrop(delta);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
  });

  test("escalates to danger when rating drops ≥0.4 stars", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.8,
      ratingToday: 4.3,
      newLowStarReviews: 0,
      newTotalReviews: 0,
    };
    const events = evaluateRatingDrop(delta);
    expect(events[0]!.severity).toBe("danger");
  });

  test("does not fire on micro-drops", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.6,
      ratingToday: 4.55,
      newLowStarReviews: 0,
      newTotalReviews: 0,
    };
    expect(evaluateRatingDrop(delta)).toEqual([]);
  });

  test("does not fire when ratings are null", () => {
    const delta: RatingDelta = {
      ratingBaseline: null,
      ratingToday: null,
      newLowStarReviews: 0,
      newTotalReviews: 0,
    };
    expect(evaluateRatingDrop(delta)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateReviewSentiment
// ─────────────────────────────────────────────────────────────────────

describe("evaluateReviewSentiment", () => {
  test("fires warning when ≥3 low-star reviews land in one day", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.6,
      ratingToday: 4.6,
      newLowStarReviews: 3,
      newTotalReviews: 10,
    };
    const events = evaluateReviewSentiment(delta);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("warning");
  });

  test("escalates to danger when count is ≥3x threshold", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.6,
      ratingToday: 4.6,
      newLowStarReviews: 12,
      newTotalReviews: 20,
    };
    const events = evaluateReviewSentiment(delta);
    expect(events[0]!.severity).toBe("danger");
  });

  test("does not fire below the floor", () => {
    const delta: RatingDelta = {
      ratingBaseline: 4.6,
      ratingToday: 4.6,
      newLowStarReviews: 2,
      newTotalReviews: 5,
    };
    expect(evaluateReviewSentiment(delta)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateAllAlarms — integration / ordering
// ─────────────────────────────────────────────────────────────────────

describe("evaluateAllAlarms", () => {
  test("sorts events by severity descending (danger > warning > info)", () => {
    const events = evaluateAllAlarms({
      keywordDeltas: [
        kw({ trackedKeywordId: "tk_drop", rankYesterday: 2, rankToday: 9 }), // danger
        kw({ trackedKeywordId: "tk_info", rankYesterday: 18, rankToday: 9 }), // rise → info
      ],
      competitorDeltas: [
        comp({ rankYesterday: 20, rankToday: 8, ourRankToday: 4 }), // warning
      ],
    });
    const severities = events.map((e) => e.severity);
    // Danger comes first; info comes last. (Warning between is fine.)
    expect(severities[0]).toBe("danger");
    expect(severities.at(-1)).toBe("info");
  });

  test("aggregates events from every evaluator family", () => {
    const events = evaluateAllAlarms({
      keywordDeltas: [
        kw({ keyword: "a", rankYesterday: 5, rankToday: 12 }),
        kw({ keyword: "b", bucketYesterday: "STABLE", bucketToday: "DECAY" }),
        kw({ keyword: "c", bucketYesterday: "STABLE", bucketToday: "DECAY" }),
        kw({ keyword: "d", bucketYesterday: "STABLE", bucketToday: "DECAY" }),
      ],
      competitorDeltas: [comp({ rankYesterday: 20, rankToday: 6, ourRankToday: 3 })],
      conversion: {
        cvrBaseline: 5,
        cvrToday: 3,
        impressionsToday: 600,
        impressionsBaseline: 600,
        downloadsToday: 18,
        downloadsBaseline: 30,
      },
      rating: {
        ratingBaseline: 4.6,
        ratingToday: 4.3,
        newLowStarReviews: 5,
        newTotalReviews: 12,
      },
    });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("KEYWORD_RANK_DROP")).toBe(true);
    expect(kinds.has("BUCKET_DEGRADATION")).toBe(true);
    expect(kinds.has("CONVERSION_DROP")).toBe(true);
    expect(kinds.has("RATING_DROP")).toBe(true);
    expect(kinds.has("REVIEW_SENTIMENT")).toBe(true);
    // Either OVERTOOK_US or INTRUSION should be present
    expect(
      kinds.has("COMPETITOR_INTRUSION") || kinds.has("COMPETITOR_OVERTOOK_US"),
    ).toBe(true);
  });

  test("threshold overrides flow through to evaluators", () => {
    // Default drop threshold is positions=3 — a 2-position move is silent.
    const eventsDefault = evaluateAllAlarms({
      keywordDeltas: [kw({ rankYesterday: 10, rankToday: 12 })],
      competitorDeltas: [],
    });
    expect(eventsDefault).toEqual([]);

    // Override loosens to positions=1 — same 2-position move now fires.
    const eventsOverride = evaluateAllAlarms({
      keywordDeltas: [kw({ rankYesterday: 10, rankToday: 12 })],
      competitorDeltas: [],
      overrides: {
        KEYWORD_RANK_DROP: { positions: 1, relevantUpTo: 50 },
      },
    });
    expect(eventsOverride).toHaveLength(1);
  });

  test("returns empty array when nothing fires", () => {
    const events = evaluateAllAlarms({
      keywordDeltas: [kw({ rankYesterday: 5, rankToday: 5 })],
      competitorDeltas: [],
    });
    expect(events).toEqual([]);
  });

  test("skips conversion + rating evaluators when their inputs are absent", () => {
    const events = evaluateAllAlarms({
      keywordDeltas: [],
      competitorDeltas: [],
    });
    expect(events).toEqual([]);
  });
});
