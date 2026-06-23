/**
 * Merge multiple Astro analyze job results into a single per-locale
 * view. Used by `GET /aso/astro/latest` so per-locale re-runs don't
 * wipe other locales' proposals.
 *
 * Strategy: walk the input list newest-first and keep the FIRST
 * occurrence of each locale (and territory) — that's the freshest.
 * Older runs that touched the same locale get masked. Totals are
 * recomputed from the merged set so the banner numbers stay coherent
 * with what the user actually sees per-locale.
 *
 * Pure & deterministic — kept out of the route handler so we can unit-
 * test it without spinning up Prisma/Next.
 */

export interface CompletedJobInput {
  /** Job id — used to populate `perLocaleJobId`. */
  id: string;
  /** Completion time. Callers MUST sort newest-first; we do NOT
   *  re-sort here. ISO string. */
  finishedAt: string | null;
  /** The shape persisted on `Job.result` for `aso.astro.analyze`. */
  result: AnalyzeJobResult | null;
}

export interface AnalyzeJobResult {
  astroAppId?: string | null;
  endpoint?: string;
  syncByTerritory?: SyncBucket[];
  recommendationsByLocale?: RecommendationBucket[];
  totals?: AnalyzeTotals;
  durationMs?: number;
  targetLocales?: string[] | null;
}

export interface SyncBucket {
  territory: string;
  added: number;
  skipped: number;
  skippedKeywords: string[];
  error?: string;
}

export interface RecommendationBucket {
  locale: string;
  territory: string;
  currentKeywordsField: string;
  proposals: { kind?: string }[];
  diagnostics: unknown;
}

export interface AnalyzeTotals {
  added: number;
  skipped: number;
  proposals: number;
  autoSwaps: number;
  opportunities: number;
}

export interface MergedSnapshot {
  astroAppId: string | null;
  endpoint: string;
  syncByTerritory: SyncBucket[];
  recommendationsByLocale: RecommendationBucket[];
  totals: AnalyzeTotals;
  durationMs: number;
}

export interface MergeResult {
  /** Merged view across the supplied jobs. Null when every job had no
   *  usable result (queued/failed/missing). */
  merged: MergedSnapshot | null;
  /** Locale → ISO timestamp of the run that produced THAT locale's
   *  currently-shown proposals. Empty object when no locales were
   *  populated. */
  perLocaleAnalyzedAt: Record<string, string>;
  /** Locale → job id that produced the locale's current view. */
  perLocaleJobId: Record<string, string>;
}

/**
 * Merge a list of completed jobs into a single per-locale view.
 * The input MUST be sorted newest-first (by `finishedAt`).
 */
export function mergeAstroSnapshots(jobs: CompletedJobInput[]): MergeResult {
  const mergedByLocale = new Map<string, RecommendationBucket>();
  const mergedSyncByTerritory = new Map<string, SyncBucket>();
  const perLocaleAnalyzedAt: Record<string, string> = {};
  const perLocaleJobId: Record<string, string> = {};
  let astroAppId: string | null = null;
  let endpoint = "";
  let mostRecentDurationMs = 0;

  for (const job of jobs) {
    const payload = job.result;
    if (!payload) continue;

    if (!endpoint && typeof payload.endpoint === "string") {
      endpoint = payload.endpoint;
    }
    if (astroAppId == null && payload.astroAppId != null) {
      astroAppId = payload.astroAppId;
    }
    if (mostRecentDurationMs === 0 && typeof payload.durationMs === "number") {
      mostRecentDurationMs = payload.durationMs;
    }

    // Per-locale buckets — newest wins.
    const buckets = Array.isArray(payload.recommendationsByLocale)
      ? payload.recommendationsByLocale
      : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket.locale !== "string") continue;
      if (mergedByLocale.has(bucket.locale)) continue; // covered by a newer run
      mergedByLocale.set(bucket.locale, bucket);
      if (job.finishedAt) {
        perLocaleAnalyzedAt[bucket.locale] = job.finishedAt;
        perLocaleJobId[bucket.locale] = job.id;
      }
    }

    // Sync buckets — newest wins per territory.
    const syncBuckets = Array.isArray(payload.syncByTerritory)
      ? payload.syncByTerritory
      : [];
    for (const sb of syncBuckets) {
      if (!sb || typeof sb.territory !== "string") continue;
      if (mergedSyncByTerritory.has(sb.territory)) continue;
      mergedSyncByTerritory.set(sb.territory, sb);
    }
  }

  const recommendationsByLocale = [...mergedByLocale.values()];
  const syncByTerritory = [...mergedSyncByTerritory.values()];

  if (recommendationsByLocale.length === 0) {
    return {
      merged: null,
      perLocaleAnalyzedAt,
      perLocaleJobId,
    };
  }

  // Recompute totals from the merged set — banner numbers must match
  // what the user actually sees per-locale, not the most recent job's
  // partial totals.
  const totals: AnalyzeTotals = {
    added: syncByTerritory.reduce((s, b) => s + (b.added ?? 0), 0),
    skipped: syncByTerritory.reduce((s, b) => s + (b.skipped ?? 0), 0),
    proposals: 0,
    autoSwaps: 0,
    opportunities: 0,
  };
  for (const bucket of recommendationsByLocale) {
    const proposals = Array.isArray(bucket.proposals) ? bucket.proposals : [];
    totals.proposals += proposals.length;
    for (const p of proposals) {
      // DECAY_AUTO bucketed alone; everything else (OPPORTUNITY_PREVIEW
      // + OPPORTUNITY_NEW) counts as a non-auto "opportunity" because
      // the banner UI only needs the binary "auto vs human-review" split.
      if (p.kind === "DECAY_AUTO") totals.autoSwaps++;
      else totals.opportunities++;
    }
  }

  return {
    merged: {
      astroAppId,
      endpoint,
      syncByTerritory,
      recommendationsByLocale,
      totals,
      durationMs: mostRecentDurationMs,
    },
    perLocaleAnalyzedAt,
    perLocaleJobId,
  };
}
