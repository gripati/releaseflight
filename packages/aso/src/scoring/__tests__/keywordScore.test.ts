import { describe, expect, test } from "vitest";
import { keywordScore } from "../keywordScore";

describe("keywordScore — Astro-only signals", () => {
  test("all signals max → score 1.0, bucket CHAMPION", () => {
    const r = keywordScore({
      appStoreRank: 1,
      volume: 100,
      maxVolume: 100,
      difficulty: 0,
      maxReachChance: 100,
    });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.bucket).toBe("CHAMPION");
  });

  test("all signals zero → score ~ 0", () => {
    const r = keywordScore({
      appStoreRank: 50,
      volume: 0,
      maxVolume: 100,
      difficulty: 100,
      maxReachChance: 0,
    });
    expect(r.score).toBeLessThan(0.05);
  });

  test("only volume signal present", () => {
    // 2500 / 5000 = 0.5 — re-normalised to single component
    const r = keywordScore({
      appStoreRank: null,
      volume: 2500,
      maxVolume: 5000,
    });
    expect(r.score).toBeCloseTo(0.5, 2);
  });

  test("difficulty is inverted — 0 difficulty → max ease", () => {
    const easy = keywordScore({ appStoreRank: null, difficulty: 0 });
    const hard = keywordScore({ appStoreRank: null, difficulty: 100 });
    expect(easy.score).toBe(1);
    expect(hard.score).toBe(0);
  });

  test("maxReachChance ≤100 is treated as a percentage", () => {
    const r = keywordScore({ appStoreRank: null, maxReachChance: 60 });
    expect(r.score).toBeCloseTo(0.6, 2);
  });

  test("maxReachChance > 100 is log-normalised so big numbers don't dominate", () => {
    const r = keywordScore({ appStoreRank: null, maxReachChance: 1_000_000 });
    // log10(1e6 + 1) ≈ 6 → 6/7 ≈ 0.857
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  test("Astro signals blend through weight re-normalisation", () => {
    const r = keywordScore({
      appStoreRank: null,
      volume: 80,
      maxVolume: 100, // 0.8 × weight 0.40
      difficulty: 20, // 0.8 × weight 0.25
      maxReachChance: 80, // 0.8 × weight 0.15
    });
    // Three signals at 0.8 each — weighted blend equals 0.8
    expect(r.score).toBeCloseTo(0.8, 2);
  });

  test("volume without maxVolume falls back to /100 normalisation", () => {
    // No explicit cap — Astro popularity is 0–100, so volume=40 → 0.4
    const r = keywordScore({ appStoreRank: null, volume: 40 });
    expect(r.score).toBeCloseTo(0.4, 2);
  });

  test("astro signals drive CHAMPION bucket with strong rank", () => {
    const r = keywordScore({
      appStoreRank: 3,
      volume: 90,
      maxVolume: 100,
      difficulty: 12,
      maxReachChance: 80,
    });
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.bucket).toBe("CHAMPION");
  });

  test("empty input → 0 NEUTRAL", () => {
    const r = keywordScore({ appStoreRank: null });
    expect(r.score).toBe(0);
    expect(r.bucket).toBe("NEUTRAL");
  });

  test("low score + no rank → DECAY", () => {
    const r = keywordScore({
      appStoreRank: null,
      volume: 5,
      maxVolume: 100,
      difficulty: 90,
    });
    expect(r.score).toBeLessThan(0.2);
    expect(r.bucket).toBe("DECAY");
  });

  test("OPPORTUNITY: score ≥ 0.4 with rank outside top-10", () => {
    const r = keywordScore({
      appStoreRank: 25,
      volume: 60,
      maxVolume: 100,
      difficulty: 30,
      maxReachChance: 50,
    });
    expect(r.score).toBeGreaterThanOrEqual(0.4);
    expect(r.bucket).toBe("OPPORTUNITY");
  });
});
