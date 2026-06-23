import { describe, expect, test } from "vitest";
import { summariseAdoptedPerformance } from "../adoptedPerformance";

describe("summariseAdoptedPerformance", () => {
  test("returns insufficient verdict when either side has < 3 listed rows", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a1", rankToday: 5, tags: ["adopted"] },
        { trackedKeywordId: "d1", rankToday: 10, tags: ["default"] },
        { trackedKeywordId: "d2", rankToday: 12, tags: ["default"] },
      ],
    });
    expect(r.verdict).toBe("insufficient");
    expect(r.adoptedTotal).toBe(1);
    expect(r.defaultTotal).toBe(2);
  });

  test("verdict=winning when adopted avg rank is ≥ 2 better than default", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a1", rankToday: 5, tags: ["adopted"] },
        { trackedKeywordId: "a2", rankToday: 6, tags: ["adopted"] },
        { trackedKeywordId: "a3", rankToday: 4, tags: ["adopted"] },
        { trackedKeywordId: "d1", rankToday: 15, tags: ["default"] },
        { trackedKeywordId: "d2", rankToday: 18, tags: ["default"] },
        { trackedKeywordId: "d3", rankToday: 14, tags: ["default"] },
      ],
    });
    expect(r.verdict).toBe("winning");
    expect(r.adoptedAvgRank).toBe(5);
    expect(r.defaultAvgRank).toBeCloseTo(15.67, 1);
    expect(r.rankDelta).toBeLessThan(0);
  });

  test("verdict=behind when adopted avg rank is ≥ 2 worse than default", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a1", rankToday: 25, tags: ["adopted"] },
        { trackedKeywordId: "a2", rankToday: 28, tags: ["adopted"] },
        { trackedKeywordId: "a3", rankToday: 30, tags: ["adopted"] },
        { trackedKeywordId: "d1", rankToday: 8, tags: ["default"] },
        { trackedKeywordId: "d2", rankToday: 10, tags: ["default"] },
        { trackedKeywordId: "d3", rankToday: 12, tags: ["default"] },
      ],
    });
    expect(r.verdict).toBe("behind");
    expect(r.rankDelta).toBeGreaterThan(0);
  });

  test("verdict=even when the gap is within ±2 positions", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a1", rankToday: 10, tags: ["adopted"] },
        { trackedKeywordId: "a2", rankToday: 11, tags: ["adopted"] },
        { trackedKeywordId: "a3", rankToday: 12, tags: ["adopted"] },
        { trackedKeywordId: "d1", rankToday: 10, tags: ["default"] },
        { trackedKeywordId: "d2", rankToday: 12, tags: ["default"] },
        { trackedKeywordId: "d3", rankToday: 11, tags: ["default"] },
      ],
    });
    expect(r.verdict).toBe("even");
  });

  test("excludes off-list rows from the avg but counts them toward total", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a1", rankToday: 5, tags: ["adopted"] },
        { trackedKeywordId: "a2", rankToday: null, tags: ["adopted"] }, // off-list
        { trackedKeywordId: "a3", rankToday: 7, tags: ["adopted"] },
      ],
    });
    expect(r.adoptedTotal).toBe(3);
    expect(r.adoptedListed).toBe(2);
    expect(r.adoptedAvgRank).toBe(6);
  });

  test("handles double-tagged rows (default+adopted) by counting in both buckets", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "x", rankToday: 5, tags: ["adopted", "default"] },
      ],
    });
    expect(r.adoptedTotal).toBe(1);
    expect(r.defaultTotal).toBe(1);
  });

  test("returns empty summary when no rows", () => {
    const r = summariseAdoptedPerformance({ rows: [] });
    expect(r.adoptedTotal).toBe(0);
    expect(r.defaultTotal).toBe(0);
    expect(r.adoptedAvgRank).toBeNull();
    expect(r.defaultAvgRank).toBeNull();
    expect(r.rankDelta).toBeNull();
    expect(r.verdict).toBe("insufficient");
  });

  test("tag matching is case-insensitive", () => {
    const r = summariseAdoptedPerformance({
      rows: [
        { trackedKeywordId: "a", rankToday: 8, tags: ["ADOPTED"] },
        { trackedKeywordId: "b", rankToday: 6, tags: ["Adopted"] },
        { trackedKeywordId: "c", rankToday: 7, tags: ["adopted"] },
      ],
    });
    expect(r.adoptedTotal).toBe(3);
    expect(r.adoptedListed).toBe(3);
  });
});
