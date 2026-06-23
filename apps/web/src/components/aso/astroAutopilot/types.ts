/**
 * Wire shapes for the Astro autopilot subsystem — kept in one place so
 * the banner, the per-locale section, and the provider all share types.
 *
 * These mirror `/api/v1/apps/[id]/aso/astro/analyze` (job result) and
 * `/api/v1/apps/[id]/aso/astro/latest` (snapshot) responses.
 */

export interface AstroSwapProposal {
  weak: {
    trackedKeywordId: string;
    keyword: string;
    score: number | null;
    bucket: string | null;
    rank: number | null;
  } | null;
  strong: {
    keyword: string;
    predictedScore: number;
    sources: string[];
    astro: {
      popularity: number | null;
      volume: number | null;
      maxVolume: number | null;
      difficulty: number | null;
      maxReachChance: number | null;
    };
    cluster?: string | null;
    reason?: string | null;
  };
  /**
   * • DECAY_AUTO          — weak → strong, weak side is DECAY (safe).
   * • OPPORTUNITY_PREVIEW — weak → strong, score uplift but weak side
   *                          is healthier than DECAY; user reviews.
   * • OPPORTUNITY_NEW     — no weak counterpart. Fresh app-relevant
   *                          candidate the user can ADD to the field
   *                          (not a swap). Surfaced even when the field
   *                          has no weak keywords, so the panel is
   *                          never empty when Astro has anything
   *                          app-relevant.
   */
  kind: "DECAY_AUTO" | "OPPORTUNITY_PREVIEW" | "OPPORTUNITY_NEW";
  scoreDelta: number;
  rationale: string;
}

export interface AstroRecommendByLocale {
  locale: string;
  territory: string;
  currentKeywordsField: string;
  proposals: AstroSwapProposal[];
  diagnostics: {
    weakCandidateCount: number;
    strongCandidateCount: number;
    suggestionSampleCount: number;
    competitorSampleCount: number;
  } | null;
  error?: string;
}

export interface AstroAnalyzeResponse {
  astroAppId: string | null;
  endpoint: string;
  syncByTerritory: {
    territory: string;
    added: number;
    skipped: number;
    skippedKeywords: string[];
    error?: string;
  }[];
  recommendationsByLocale: AstroRecommendByLocale[];
  totals: {
    added: number;
    skipped: number;
    proposals: number;
    autoSwaps: number;
    opportunities: number;
  };
  durationMs: number;
}

export interface AstroJobSnapshot {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";
  progress: { current: number; total: number; step: string | null };
  result: AstroAnalyzeResponse | null;
  error: { code?: string; message?: string } | null;
  createdAt: string;
  finishedAt: string | null;
  /** Locale set the job is/was targeting. `null` = whole-app run. Set
   *  by the latest-endpoint from the original job payload so the UI can
   *  show "Analysing fr…" only on the relevant per-locale section. */
  targetLocales: string[] | null;
}

/** Combined shape returned by `GET /aso/astro/latest`. Replaces the
 *  old "single job result" — the merged view unions per-locale results
 *  across the last N completed jobs so per-locale runs don't wipe
 *  other locales' proposals. */
export interface AstroLatestSnapshot {
  job: AstroJobSnapshot | null;
  merged: AstroAnalyzeResponse | null;
  /** Locale → ISO timestamp of the run that produced THAT locale's
   *  currently-shown proposals. Used for "Last analyzed 2h ago" chips. */
  perLocaleAnalyzedAt: Record<string, string>;
  /** Locale → job id that produced the locale's current view. Used by
   *  the UI to deep-link a "view job" affordance per locale. */
  perLocaleJobId: Record<string, string>;
}

export interface AstroApplyResponse {
  perLocale: {
    locale: string;
    territory: string;
    before: string;
    after: string;
    applied: number;
    pairs: { weakKeyword: string | null; strongKeyword: string; status: string }[];
  }[];
  totalApplied: number;
  newTrackedKeywords: number;
}

export type AstroPhase = "loading" | "idle" | "queued" | "running" | "done";
