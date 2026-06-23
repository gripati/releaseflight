import { describe, expect, test } from "vitest";
import {
  getCurrentSeasonalThemes,
  getUpcomingSeasonalThemes,
} from "../seasonalCalendar";

describe("getCurrentSeasonalThemes", () => {
  test("Halloween is active in early October", () => {
    const oct10 = new Date(Date.UTC(2026, 9, 10)); // Oct 10
    const themes = getCurrentSeasonalThemes("game", oct10);
    expect(themes.some((t) => t.id === "halloween")).toBe(true);
  });

  test("Christmas active mid-December", () => {
    const dec15 = new Date(Date.UTC(2026, 11, 15));
    const themes = getCurrentSeasonalThemes("game", dec15);
    expect(themes.some((t) => t.id === "christmas")).toBe(true);
  });

  test("New Year active early January (cross-year ramp)", () => {
    const jan5 = new Date(Date.UTC(2027, 0, 5));
    const themes = getCurrentSeasonalThemes("game", jan5);
    expect(themes.some((t) => t.id === "new-year")).toBe(true);
  });

  test("Tax season finance only", () => {
    const mar20 = new Date(Date.UTC(2026, 2, 20));
    const gameThemes = getCurrentSeasonalThemes("game", mar20);
    expect(gameThemes.some((t) => t.id === "tax-season-us")).toBe(false);
    const financeThemes = getCurrentSeasonalThemes("finance", mar20);
    expect(financeThemes.some((t) => t.id === "tax-season-us")).toBe(true);
  });

  test("Beach body active in spring fitness", () => {
    const apr20 = new Date(Date.UTC(2026, 3, 20));
    const themes = getCurrentSeasonalThemes("health", apr20);
    expect(themes.some((t) => t.id === "beach-body")).toBe(true);
  });

  test("Back-to-school active August/September", () => {
    const aug20 = new Date(Date.UTC(2026, 7, 20));
    const themes = getCurrentSeasonalThemes("education", aug20);
    expect(themes.some((t) => t.id === "back-to-school")).toBe(true);
  });

  test("Universal themes (categories: ['*']) match any category", () => {
    const dec25 = new Date(Date.UTC(2026, 11, 25));
    const themes = getCurrentSeasonalThemes("game", dec25);
    expect(themes.some((t) => t.id === "new-year")).toBe(true);
  });

  test("Off-season returns empty / few themes", () => {
    // mid-September for finance — nothing special peaks
    const sep15 = new Date(Date.UTC(2026, 8, 15));
    const themes = getCurrentSeasonalThemes("finance", sep15);
    expect(themes.some((t) => t.id === "tax-season-us")).toBe(false);
  });
});

describe("getUpcomingSeasonalThemes", () => {
  test("returns themes peaking within lookahead", () => {
    // From Oct 1, look 90 days ahead — Christmas (Dec 15) is upcoming
    const oct1 = new Date(Date.UTC(2026, 9, 1));
    const up = getUpcomingSeasonalThemes("game", oct1, 90);
    expect(up.some((u) => u.theme.id === "christmas")).toBe(true);
  });

  test("excludes themes already in active ramp window", () => {
    // Halloween peaks Oct 15, ramps 30 days. Oct 10 → Halloween is
    // already active, NOT "upcoming".
    const oct10 = new Date(Date.UTC(2026, 9, 10));
    const up = getUpcomingSeasonalThemes("game", oct10, 60);
    expect(up.some((u) => u.theme.id === "halloween")).toBe(false);
  });

  test("daysUntilPeak is positive and ordered ascending", () => {
    const sep1 = new Date(Date.UTC(2026, 8, 1));
    const up = getUpcomingSeasonalThemes("game", sep1, 180);
    expect(up.every((u) => u.daysUntilPeak > 0)).toBe(true);
    for (let i = 1; i < up.length; i++) {
      expect(up[i]!.daysUntilPeak).toBeGreaterThanOrEqual(up[i - 1]!.daysUntilPeak);
    }
  });

  test("filters by app category", () => {
    const feb1 = new Date(Date.UTC(2026, 1, 1));
    const gameUp = getUpcomingSeasonalThemes("game", feb1, 120);
    const financeUp = getUpcomingSeasonalThemes("finance", feb1, 120);
    // Tax season only surfaces in finance
    expect(gameUp.some((u) => u.theme.id === "tax-season-us")).toBe(false);
    expect(financeUp.some((u) => u.theme.id === "tax-season-us")).toBe(true);
  });
});
