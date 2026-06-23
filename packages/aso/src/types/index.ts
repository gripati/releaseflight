/**
 * Shared types for the ASO Intelligence package. Astro is the single
 * source of truth for ASO signals — see docs/16_ASO_INTELLIGENCE.md.
 * Kept I/O-free; anything that hits a network lives in adapter packages.
 */

/** A keyword's UI bucket, derived from the composite score + delta history. */
export type KeywordBucket = "CHAMPION" | "OPPORTUNITY" | "RISING" | "DECAY" | "NEUTRAL";

/** All sources Apple Analytics exposes in its per-source funnel report. */
export type AnalyticsSource =
  | "SEARCH"
  | "BROWSE"
  | "APP_REFERRER"
  | "WEB_REFERRER"
  | "INSTITUTIONAL"
  | "UNAVAILABLE";

/**
 * Raw daily inputs for a keyword on a specific date. Every field is
 * nullable so partial coverage doesn't crash scoring; the weights are
 * re-normalised across whatever signals are present.
 *
 * All signal data flows from Astro MCP today. `appStoreRank`,
 * `volume`, `maxVolume`, `difficulty`, and `maxReachChance` come
 * directly from Astro's `search_rankings` / `add_keywords` responses.
 */
export interface KeywordSignalInput {
  /** Our app's App Store search rank (1-indexed, null if outside top 50). */
  appStoreRank: number | null;
  /** Astro popularity (0–100). On Astro's tracked-keyword payload this
   *  is Apple's real search index multiplied by 20 (Apple's 0–5 scale). */
  volume?: number | null;
  /** Cap of the volume scale, so UI can render volume / maxVolume %. */
  maxVolume?: number | null;
  /** 0–100 Astro keyword difficulty (higher = harder to rank for). */
  difficulty?: number | null;
  /** Astro's "max reach chance" — estimated impressions if ranked #1. */
  maxReachChance?: number | null;
  /** Optional — the keyword text. When passed, scoring applies the
   *  multi-word boost (1-word 0.85, 2-word 1.05, 3+ word 1.15) so
   *  long-tail terms reflect their niche-ASO value. */
  keyword?: string;
  /** Optional — the locale code (e.g. "cs", "ja-JP"). When passed
   *  together with `keyword`, scoring applies a language-match
   *  multiplier [0.45, 1.10] that boosts script/diacritic-appropriate
   *  candidates and penalises clear mismatches. */
  localeHint?: string;
}

/** Final score + bucket, suitable for direct UI / DB persistence. */
export interface KeywordSignalOutput {
  score: number; // 0..1
  bucket: KeywordBucket;
}

/** Funnel rollup for a date range — used by the Overview KPI cards. */
export interface FunnelTotals {
  impressions: number;
  pageViews: number;
  downloads: number;
  firstTimeDownloads: number;
  pvcrPct: number;
}

/** Detected anomaly worth surfacing in the UI. */
export interface FunnelDiagnostic {
  kind: "PVCR_DROP" | "PVCR_SPIKE" | "IMPRESSION_DROP" | "IMPRESSION_SPIKE";
  severity: "LOW" | "MEDIUM" | "HIGH";
  message: string;
  detectedAt: Date;
  metricDelta: number; // signed %
  baselineWindowDays: number;
}
