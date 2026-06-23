import { describe, expect, test } from "vitest";
import {
  summariseRankMovers,
  topClimbers,
  topDecliners,
} from "../rankMovers";
import type { KeywordRankDelta } from "../alarmEngine";

function kw(partial: Partial<KeywordRankDelta> = {}): KeywordRankDelta {
  return {
    trackedKeywordId: "tk_1",
    keyword: "merge puzzle",
    territory: "US",
    rankToday: null,
    rankYesterday: null,
    bucketToday: null,
    bucketYesterday: null,
    scoreToday: null,
    scoreYesterday: null,
    temporal: null,
    tags: [],
    ...partial,
  };
}

describe("summariseRankMovers", () => {
  test("skips rows where both ranks are null", () => {
    const r = summariseRankMovers([kw({ rankYesterday: null, rankToday: null })]);
    expect(r.movers).toEqual([]);
    expect(r.totals).toEqual({
      climbers: 0,
      decliners: 0,
      entered: 0,
      exited: 0,
      unchanged: 0,
    });
  });

  test("classifies a same-rank row as unchanged (excluded from movers)", () => {
    const r = summariseRankMovers([kw({ rankYesterday: 8, rankToday: 8 })]);
    expect(r.movers).toEqual([]);
    expect(r.totals.unchanged).toBe(1);
  });

  test("captures small numeric improvements that wouldn't fire alarms", () => {
    const r = summariseRankMovers([
      kw({ trackedKeywordId: "a", keyword: "a", rankYesterday: 10, rankToday: 9 }),
    ]);
    expect(r.movers).toHaveLength(1);
    expect(r.movers[0]).toMatchObject({
      direction: "up",
      delta: 1,
      magnitude: 1,
    });
    expect(r.totals.climbers).toBe(1);
  });

  test("captures small declines that wouldn't fire alarms", () => {
    const r = summariseRankMovers([
      kw({ trackedKeywordId: "b", keyword: "b", rankYesterday: 7, rankToday: 9 }),
    ]);
    expect(r.movers[0]!.direction).toBe("down");
    expect(r.movers[0]!.delta).toBe(-2);
    expect(r.totals.decliners).toBe(1);
  });

  test("flags list-entry events (null → ranked)", () => {
    const r = summariseRankMovers([
      kw({ rankYesterday: null, rankToday: 5 }),
    ]);
    expect(r.movers[0]).toMatchObject({
      direction: "entered",
      delta: null,
      rankToday: 5,
    });
    expect(r.totals.entered).toBe(1);
  });

  test("flags list-exit events (ranked → null)", () => {
    const r = summariseRankMovers([
      kw({ rankYesterday: 3, rankToday: null }),
    ]);
    expect(r.movers[0]).toMatchObject({
      direction: "exited",
      delta: null,
      rankYesterday: 3,
    });
    expect(r.totals.exited).toBe(1);
  });

  test("sorts by magnitude descending — biggest movers first", () => {
    const r = summariseRankMovers([
      kw({ trackedKeywordId: "small", keyword: "small", rankYesterday: 10, rankToday: 9 }),
      kw({ trackedKeywordId: "big", keyword: "big", rankYesterday: 30, rankToday: 12 }),
      kw({ trackedKeywordId: "mid", keyword: "mid", rankYesterday: 20, rankToday: 14 }),
    ]);
    expect(r.movers.map((m) => m.keyword)).toEqual(["big", "mid", "small"]);
  });

  test("top-3 exit out-ranks a 15-position drop in magnitude", () => {
    const r = summariseRankMovers([
      kw({ trackedKeywordId: "exit", keyword: "exit-top3", rankYesterday: 3, rankToday: null }),
      kw({ trackedKeywordId: "drop", keyword: "drop-15", rankYesterday: 12, rankToday: 27 }),
    ]);
    // exit-top3 has synthetic magnitude (100 - 6) = 94, beating the 15-drop
    expect(r.movers[0]!.keyword).toBe("exit-top3");
    expect(r.movers[1]!.keyword).toBe("drop-15");
  });

  test("breaks ties: entered > improved > declined > exited, then alpha", () => {
    const r = summariseRankMovers([
      kw({ trackedKeywordId: "a", keyword: "alpha-up", rankYesterday: 11, rankToday: 6 }),
      kw({ trackedKeywordId: "b", keyword: "beta-down", rankYesterday: 6, rankToday: 11 }),
    ]);
    // Both have magnitude 5; the climber should come first.
    expect(r.movers[0]!.keyword).toBe("alpha-up");
    expect(r.movers[1]!.keyword).toBe("beta-down");
  });
});

describe("topClimbers / topDecliners", () => {
  const fixture = summariseRankMovers([
    kw({ trackedKeywordId: "1", keyword: "rise-big", rankYesterday: 30, rankToday: 10 }),
    kw({ trackedKeywordId: "2", keyword: "rise-small", rankYesterday: 8, rankToday: 6 }),
    kw({ trackedKeywordId: "3", keyword: "drop-big", rankYesterday: 5, rankToday: 25 }),
    kw({ trackedKeywordId: "4", keyword: "drop-small", rankYesterday: 9, rankToday: 12 }),
    kw({ trackedKeywordId: "5", keyword: "entry", rankYesterday: null, rankToday: 7 }),
    kw({ trackedKeywordId: "6", keyword: "exit", rankYesterday: 5, rankToday: null }),
  ]);

  test("topClimbers returns up + entered, biggest first", () => {
    const climbers = topClimbers(fixture, 5);
    expect(climbers.map((m) => m.keyword)).toEqual([
      "entry",      // magnitude 86 (top-3-ish synthetic)
      "rise-big",   // 20
      "rise-small", // 2
    ]);
  });

  test("topDecliners returns down + exited, biggest first", () => {
    const decliners = topDecliners(fixture, 5);
    expect(decliners.map((m) => m.keyword)).toEqual([
      "exit",       // magnitude 90
      "drop-big",   // 20
      "drop-small", // 3
    ]);
  });

  test("respects the N cap", () => {
    expect(topClimbers(fixture, 1)).toHaveLength(1);
    expect(topDecliners(fixture, 2)).toHaveLength(2);
  });
});
