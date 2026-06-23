import { describe, expect, test } from "vitest";
import {
  temporalBucket,
  applyTemporalOverride,
  type HistoricalSignal,
} from "../temporalBucket";

function sig(date: string, score: number | null, rank: number | null = null): HistoricalSignal {
  return { date, score, appStoreRank: rank };
}

describe("temporalBucket — delta detection", () => {
  test("returns null when fewer than 3 days of history", () => {
    expect(temporalBucket([])).toBeNull();
    expect(temporalBucket([sig("2026-05-19", 0.5)])).toBeNull();
    expect(temporalBucket([sig("2026-05-19", 0.5), sig("2026-05-20", 0.5)])).toBeNull();
  });

  test("RISING when score climbs ≥0.15 over the window", () => {
    const r = temporalBucket([
      sig("2026-05-13", 0.45),
      sig("2026-05-15", 0.5),
      sig("2026-05-17", 0.55),
      sig("2026-05-19", 0.62),
    ]);
    expect(r).toBe("RISING");
  });

  test("FALLING when score drops ≥0.15 over the window", () => {
    const r = temporalBucket([
      sig("2026-05-13", 0.7),
      sig("2026-05-15", 0.65),
      sig("2026-05-17", 0.6),
      sig("2026-05-19", 0.53),
    ]);
    expect(r).toBe("FALLING");
  });

  test("returns null when score is flat (delta < threshold)", () => {
    const r = temporalBucket([
      sig("2026-05-13", 0.55),
      sig("2026-05-15", 0.56),
      sig("2026-05-17", 0.54),
      sig("2026-05-19", 0.58),
    ]);
    expect(r).toBeNull();
  });

  test("RISING by rank improvement when score is flat", () => {
    // Score stays flat at 0.5 — but rank moves from #25 to #8 → +17 delta = RISING
    const r = temporalBucket([
      sig("2026-05-13", 0.5, 25),
      sig("2026-05-15", 0.5, 20),
      sig("2026-05-17", 0.5, 12),
      sig("2026-05-19", 0.5, 8),
    ]);
    expect(r).toBe("RISING");
  });

  test("FALLING by rank regression when score is flat", () => {
    const r = temporalBucket([
      sig("2026-05-13", 0.5, 5),
      sig("2026-05-15", 0.5, 10),
      sig("2026-05-17", 0.5, 18),
      sig("2026-05-19", 0.5, 22),
    ]);
    expect(r).toBe("FALLING");
  });

  test("ignores null score days when computing delta", () => {
    // Null-score days don't anchor a comparison; oldest = 0.45, newest = 0.65
    const r = temporalBucket([
      sig("2026-05-13", 0.45),
      sig("2026-05-15", null),
      sig("2026-05-17", null),
      sig("2026-05-19", 0.65),
    ]);
    expect(r).toBe("RISING");
  });

  test("sort defensively when window arrives out of order", () => {
    const r = temporalBucket([
      sig("2026-05-19", 0.65),
      sig("2026-05-13", 0.45),
      sig("2026-05-17", 0.55),
      sig("2026-05-15", 0.5),
    ]);
    expect(r).toBe("RISING");
  });

  test("score delta wins over rank delta on conflict", () => {
    // Score CRASHES 0.7 → 0.3 (FALLING) — even though rank improved 30 → 5
    const r = temporalBucket([
      sig("2026-05-13", 0.7, 30),
      sig("2026-05-15", 0.6, 20),
      sig("2026-05-17", 0.5, 10),
      sig("2026-05-19", 0.3, 5),
    ]);
    expect(r).toBe("FALLING");
  });
});

describe("applyTemporalOverride — bucket override rules", () => {
  test("CHAMPION + RISING stays CHAMPION (don't hide the win)", () => {
    expect(applyTemporalOverride("CHAMPION", "RISING")).toBe("CHAMPION");
  });

  test("CHAMPION + FALLING becomes FALLING (loud warning)", () => {
    expect(applyTemporalOverride("CHAMPION", "FALLING")).toBe("FALLING");
  });

  test("DECAY + RISING stays DECAY (don't celebrate a barely-recovering decay)", () => {
    expect(applyTemporalOverride("DECAY", "RISING")).toBe("DECAY");
  });

  test("DECAY + FALLING stays DECAY", () => {
    expect(applyTemporalOverride("DECAY", "FALLING")).toBe("DECAY");
  });

  test("OPPORTUNITY + RISING becomes RISING", () => {
    expect(applyTemporalOverride("OPPORTUNITY", "RISING")).toBe("RISING");
  });

  test("OPPORTUNITY + FALLING becomes FALLING", () => {
    expect(applyTemporalOverride("OPPORTUNITY", "FALLING")).toBe("FALLING");
  });

  test("NEUTRAL + RISING becomes RISING", () => {
    expect(applyTemporalOverride("NEUTRAL", "RISING")).toBe("RISING");
  });

  test("null temporal returns daily bucket unchanged", () => {
    expect(applyTemporalOverride("CHAMPION", null)).toBe("CHAMPION");
    expect(applyTemporalOverride("NEUTRAL", null)).toBe("NEUTRAL");
    expect(applyTemporalOverride(null, null)).toBeNull();
  });

  test("null daily bucket + null temporal returns null", () => {
    expect(applyTemporalOverride(null, null)).toBeNull();
    expect(applyTemporalOverride(undefined, null)).toBeNull();
  });
});
