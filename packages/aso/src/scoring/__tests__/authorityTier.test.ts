import { describe, expect, test } from "vitest";
import { getAuthorityTier, resolveMaxDifficulty } from "../authorityTier";

describe("getAuthorityTier", () => {
  test.each<[number | null, "new" | "growing" | "established" | "leader", number]>([
    [null, "new", 35],
    [0, "new", 35],
    [9_999, "new", 35],
    [10_000, "growing", 50],
    [99_999, "growing", 50],
    [100_000, "established", 65],
    [999_999, "established", 65],
    [1_000_000, "leader", 80],
    [50_000_000, "leader", 80],
  ])("monthlyActiveDevices=%s → tier=%s maxDifficulty=%i", (mau, tier, max) => {
    const r = getAuthorityTier(mau);
    expect(r.tier).toBe(tier);
    expect(r.maxDifficulty).toBe(max);
    expect(r.label.length).toBeGreaterThan(0);
  });
});

describe("resolveMaxDifficulty", () => {
  test("returns tier default when override is null", () => {
    expect(resolveMaxDifficulty(50_000, null)).toBe(50); // growing
    expect(resolveMaxDifficulty(2_000_000, null)).toBe(80); // leader
  });

  test("returns tier default when override is undefined", () => {
    expect(resolveMaxDifficulty(50_000)).toBe(50);
  });

  test("clamps user override into [10, 95]", () => {
    expect(resolveMaxDifficulty(50_000, 5)).toBe(10);
    expect(resolveMaxDifficulty(50_000, 100)).toBe(95);
    expect(resolveMaxDifficulty(50_000, 42)).toBe(42);
  });

  test("rounds non-integer override", () => {
    expect(resolveMaxDifficulty(50_000, 42.7)).toBe(43);
  });
});
