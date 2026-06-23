/**
 * Seasonal keyword themes — pure data + helpers.
 *
 * App Store search traffic is highly seasonal in many categories:
 *   • Games: Halloween (Sep-Oct), Christmas (Nov-Dec), New Year (Dec-Jan),
 *     Valentine's (Feb), Easter (Mar-Apr), Summer (Jun-Aug).
 *   • Fitness: New Year resolutions (Jan), Beach body / bikini (Mar-Jun).
 *   • Finance: Tax season (US: Feb-Apr).
 *   • Education: Back-to-school (Aug-Sep), exam season (May-Jun).
 *
 * Pro ASO consultants plan title/subtitle/keywords field rotations
 * 4-6 weeks AHEAD of these peaks. This module exposes:
 *
 *   • `getCurrentSeasonalThemes(appCategory, now)` — returns the
 *     themes that are CURRENTLY peaking OR ramping (within 30 days
 *     of peak). UI surfaces these as informational chips on the
 *     autopilot banner.
 *   • `getUpcomingSeasonalThemes(appCategory, now, lookaheadDays)` —
 *     forecasts themes that will peak in the next N days (default
 *     60). Used to prompt the user "Christmas keywords trending in
 *     30 days — consider re-analyze + slot moves."
 *
 * Conservative coverage — we list well-documented seasonal patterns
 * with clear evidence of search-volume spikes in App Store data. New
 * categories can be added as new evidence accrues.
 *
 * Date math is UTC-based; locale doesn't change the calendar (a
 * Japanese Christmas app still trends in December because the
 * keyword "christmas" is a global signal).
 */

import type { AppCategory } from "../research/AstroAutopilot";

/** A single seasonal theme — peaks in a given month window. */
export interface SeasonalTheme {
  /** Stable identifier for the theme. */
  id: string;
  /** Human-readable name (English; UI translates if needed). */
  label: string;
  /** Categories this theme applies to. "*" matches all categories. */
  categories: readonly (AppCategory | "*")[];
  /** Peak month (1-12, UTC). The theme is considered "PEAKING" for
   *  the 30 days centred on the 15th of this month. */
  peakMonth: number;
  /** Days BEFORE peak where the theme starts to ramp. Default 30. */
  rampDays?: number;
  /** Days AFTER peak the theme stays elevated. Default 14. */
  tailDays?: number;
  /** Suggested keyword themes (in English; act as hints for the AI
   *  relevance scorer + autopilot). The user adds locale-translated
   *  equivalents themselves. */
  suggestedThemes: readonly string[];
}

/** Canonical seasonal calendar. PR-reviewed; new entries require
 *  evidence (Astro popularity spikes in the named months). */
export const SEASONAL_THEMES: readonly SeasonalTheme[] = [
  // ── Games ────────────────────────────────────────────────────────
  {
    id: "halloween",
    label: "Halloween",
    categories: ["game"],
    peakMonth: 10, // October
    rampDays: 30,
    tailDays: 5,
    suggestedThemes: ["halloween", "scary", "horror", "ghost", "spooky", "pumpkin"],
  },
  {
    id: "christmas",
    label: "Christmas / Winter holidays",
    categories: ["game", "shopping", "lifestyle"],
    peakMonth: 12,
    rampDays: 45,
    tailDays: 10,
    suggestedThemes: ["christmas", "santa", "xmas", "holiday", "winter", "snow", "gift"],
  },
  {
    id: "new-year",
    label: "New Year",
    categories: ["*"],
    peakMonth: 1,
    rampDays: 30,
    tailDays: 21,
    suggestedThemes: ["new year", "resolution", "fresh start"],
  },
  {
    id: "valentines",
    label: "Valentine's Day",
    categories: ["game", "lifestyle", "social"],
    peakMonth: 2,
    rampDays: 21,
    tailDays: 3,
    suggestedThemes: ["valentine", "love", "romance", "couple", "date"],
  },
  {
    id: "easter",
    label: "Easter",
    categories: ["game", "shopping"],
    peakMonth: 4,
    rampDays: 21,
    tailDays: 5,
    suggestedThemes: ["easter", "egg", "bunny", "spring"],
  },
  {
    id: "summer",
    label: "Summer break",
    categories: ["game"],
    peakMonth: 7,
    rampDays: 45,
    tailDays: 30,
    suggestedThemes: ["summer", "vacation", "beach", "pool", "outdoor"],
  },

  // ── Fitness ──────────────────────────────────────────────────────
  {
    id: "new-year-fitness",
    label: "New Year fitness resolutions",
    categories: ["health"],
    peakMonth: 1,
    rampDays: 14,
    tailDays: 45,
    suggestedThemes: ["new year fitness", "resolution", "weight loss", "workout plan"],
  },
  {
    id: "beach-body",
    label: "Beach body / summer prep",
    categories: ["health"],
    peakMonth: 5,
    rampDays: 60,
    tailDays: 30,
    suggestedThemes: ["beach body", "summer body", "abs", "bikini", "tone up"],
  },

  // ── Finance (US-centric tax season) ──────────────────────────────
  {
    id: "tax-season-us",
    label: "Tax season (US)",
    categories: ["finance"],
    peakMonth: 4,
    rampDays: 60,
    tailDays: 10,
    suggestedThemes: ["tax", "irs", "tax return", "refund", "deduction"],
  },

  // ── Education ────────────────────────────────────────────────────
  {
    id: "back-to-school",
    label: "Back to school",
    categories: ["education", "books"],
    peakMonth: 8,
    rampDays: 30,
    tailDays: 21,
    suggestedThemes: ["back to school", "study", "homework", "student", "school year"],
  },
  {
    id: "exam-season",
    label: "Exam / finals season",
    categories: ["education"],
    peakMonth: 5,
    rampDays: 30,
    tailDays: 14,
    suggestedThemes: ["exam", "final", "study guide", "test prep", "cram"],
  },

  // ── Shopping ─────────────────────────────────────────────────────
  {
    id: "black-friday",
    label: "Black Friday / Cyber Monday",
    categories: ["shopping"],
    peakMonth: 11,
    rampDays: 21,
    tailDays: 7,
    suggestedThemes: ["black friday", "cyber monday", "deals", "discount", "sale"],
  },
];

/**
 * Returns themes that are CURRENTLY peaking or ramping for the given
 * app category at the given moment. A theme is "active" when:
 *
 *   peak - rampDays ≤ now ≤ peak + tailDays
 *
 * Peak is defined as the 15th of `peakMonth` UTC, since search trends
 * data shows the consistent mid-month spike for most named themes.
 */
export function getCurrentSeasonalThemes(
  appCategory: AppCategory | null,
  now: Date = new Date(),
): SeasonalTheme[] {
  return SEASONAL_THEMES.filter((t) => {
    if (appCategory != null && !t.categories.includes("*") && !t.categories.includes(appCategory)) {
      return false;
    }
    const peak = peakDateForYear(t.peakMonth, now.getUTCFullYear());
    const rampStart = addDays(peak, -(t.rampDays ?? 30));
    const tailEnd = addDays(peak, t.tailDays ?? 14);
    if (now >= rampStart && now <= tailEnd) return true;
    // Also check NEXT year's peak — late-December ramp-up for
    // January-peak themes (e.g. "new year" searches spike Dec 20+).
    const nextPeak = peakDateForYear(t.peakMonth, now.getUTCFullYear() + 1);
    const nextRampStart = addDays(nextPeak, -(t.rampDays ?? 30));
    const nextTailEnd = addDays(nextPeak, t.tailDays ?? 14);
    if (now >= nextRampStart && now <= nextTailEnd) return true;
    // And previous year's tail (early-January searches for prior
    // year's peak — uncommon but possible).
    const prevPeak = peakDateForYear(t.peakMonth, now.getUTCFullYear() - 1);
    const prevRampStart = addDays(prevPeak, -(t.rampDays ?? 30));
    const prevTailEnd = addDays(prevPeak, t.tailDays ?? 14);
    return now >= prevRampStart && now <= prevTailEnd;
  });
}

/**
 * Returns themes that will peak within `lookaheadDays` of now (default
 * 60). Useful for the "Christmas trending in 30 days — re-analyze
 * keywords" banner. Excludes themes that are already active (returned
 * by `getCurrentSeasonalThemes`).
 */
export function getUpcomingSeasonalThemes(
  appCategory: AppCategory | null,
  now: Date = new Date(),
  lookaheadDays = 60,
): { theme: SeasonalTheme; daysUntilPeak: number }[] {
  const upcoming: { theme: SeasonalTheme; daysUntilPeak: number }[] = [];
  const horizon = addDays(now, lookaheadDays);
  for (const t of SEASONAL_THEMES) {
    if (appCategory != null && !t.categories.includes("*") && !t.categories.includes(appCategory)) {
      continue;
    }
    // Find the next peak (this year or next year)
    const thisYearPeak = peakDateForYear(t.peakMonth, now.getUTCFullYear());
    const peak =
      thisYearPeak > now ? thisYearPeak : peakDateForYear(t.peakMonth, now.getUTCFullYear() + 1);
    if (peak <= horizon) {
      // Skip if it's already inside the ramp window (we'd report it
      // via getCurrentSeasonalThemes instead).
      const rampStart = addDays(peak, -(t.rampDays ?? 30));
      if (now >= rampStart) continue;
      const daysUntilPeak = Math.ceil((peak.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      upcoming.push({ theme: t, daysUntilPeak });
    }
  }
  return upcoming.sort((a, b) => a.daysUntilPeak - b.daysUntilPeak);
}

function peakDateForYear(month: number, year: number): Date {
  return new Date(Date.UTC(year, month - 1, 15));
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}
