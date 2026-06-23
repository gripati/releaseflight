/**
 * Keyword research types — Astro is the single source of truth.
 *
 * The multi-provider abstraction (AppleSearchAds, AppleSearchHints,
 * GoogleTrends, ThirdPartyAsoProvider, MultiProviderResearcher) has
 * been removed. All keyword signals now come from Astro MCP via
 * `AstroMcpClient` + `AstroAutopilot`. Field coverage here mirrors
 * what Astro returns plus the local-computed rank for back-compat.
 */

/** ISO 3166-1 alpha-2 storefront code (US, TR, JP, …). */
export type Storefront = string;

/**
 * Cross-source keyword research metrics for ONE keyword × storefront.
 * Every field is nullable so partial coverage doesn't kill the row.
 * Populated from Astro's `search_rankings` / `add_keywords` responses.
 */
export interface KeywordResearchMetrics {
  /**
   * Astro popularity (0–100). On Astro's tracked-keyword payload this
   * is Apple's real search index — same scale as Apple Search Ads's
   * 0–5 popularity multiplied by 20.
   */
  volume: number | null;
  maxVolume: number | null;

  /**
   * Astro 0-100 "how hard is it to rank for this keyword". Higher =
   * harder. Comes directly from Astro's keyword payload.
   */
  difficulty: number | null;

  /**
   * Estimated maximum reach (impressions) achievable if we ranked
   * #1 for this keyword. Capped by maxVolume.
   */
  maxReachChance: number | null;

  /** Our app's App Store search rank (1-indexed, null if outside top 50). */
  appStoreRank: number | null;
}

export function emptyMetrics(): KeywordResearchMetrics {
  return {
    volume: null,
    maxVolume: null,
    difficulty: null,
    maxReachChance: null,
    appStoreRank: null,
  };
}
