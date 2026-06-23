/**
 * Authority-tier helper.
 *
 * A brand-new app at 500 monthly installs cannot realistically break
 * the top-10 on a "difficulty 70" keyword — Apple's authority signal
 * (downloads + reviews + retention) caps how high a new app can climb.
 * A market leader at 5M installs can chase difficulty-80 terms and
 * still win.
 *
 * This helper derives an authority tier from monthly-active-device
 * count (from AnalyticsSnapshot.activeDevices30d) and recommends a
 * realistic `maxDifficulty` cap for keyword filtering. The Astro
 * autopilot uses this to filter mining candidates so new apps don't
 * see "great keyword, popularity 95, difficulty 78" suggestions that
 * are mathematically unreachable.
 *
 * Pure function, no side effects. Caller supplies the install number,
 * gets back a tier + recommended difficulty ceiling.
 */

export type AuthorityTier = "new" | "growing" | "established" | "leader";

export interface AuthorityTierResult {
  tier: AuthorityTier;
  /** Recommended ceiling for keyword mining difficulty. Candidates
   *  above this number are unwinnable at the current authority and
   *  should be filtered out before ranking. */
  maxDifficulty: number;
  /** Plain-English label for the UI / analyst prompt. */
  label: string;
}

/** Threshold matrix. Tuned against the typical small-game-studio
 *  publisher catalog — adjust if real-world data suggests otherwise. */
const TIER_THRESHOLDS: { tier: AuthorityTier; minDevices: number; maxDifficulty: number; label: string }[] = [
  { tier: "leader", minDevices: 1_000_000, maxDifficulty: 80, label: "Leader (>1M MAU)" },
  { tier: "established", minDevices: 100_000, maxDifficulty: 65, label: "Established (100K–1M MAU)" },
  { tier: "growing", minDevices: 10_000, maxDifficulty: 50, label: "Growing (10K–100K MAU)" },
  { tier: "new", minDevices: 0, maxDifficulty: 35, label: "New (<10K MAU)" },
];

/**
 * Pick a tier from monthly active devices. `null` defaults to "new" —
 * an app with no analytics data is treated as fresh.
 */
export function getAuthorityTier(monthlyActiveDevices: number | null | undefined): AuthorityTierResult {
  const installs = monthlyActiveDevices ?? 0;
  for (const t of TIER_THRESHOLDS) {
    if (installs >= t.minDevices) {
      return { tier: t.tier, maxDifficulty: t.maxDifficulty, label: t.label };
    }
  }
  // Fall-through (shouldn't happen because "new" matches 0) — defensive.
  return { tier: "new", maxDifficulty: 35, label: "New (<10K MAU)" };
}

/**
 * Allow per-app override. The autopilot lets a user pin a higher cap
 * if they know their app punches above its install weight (recent
 * spike, brand awareness, etc) — we still floor at the tier default
 * so a leader app doesn't get artificially capped below 80.
 */
export function resolveMaxDifficulty(
  monthlyActiveDevices: number | null | undefined,
  override?: number | null,
): number {
  const tier = getAuthorityTier(monthlyActiveDevices);
  if (override == null) return tier.maxDifficulty;
  // Clamp override to [10, 95] — outside that range is nonsensical.
  return Math.max(10, Math.min(95, Math.round(override)));
}
