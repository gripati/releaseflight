/**
 * Astro Autopilot — high-level orchestration on top of AstroMcpClient.
 *
 * Flow we offer the user:
 *
 *   1. ensureAppTracked()       — make sure Astro has the app registered
 *   2. syncKeywords()           — push our tracked keywords up to Astro
 *                                  in 100-token chunks
 *   3. proposeSwaps()           — fuse Astro suggestions + competitor
 *                                  combinations + local Apple / Trends
 *                                  / score signals into ranked
 *                                  weak → strong swap proposals
 *
 * Classification:
 *
 *   • DECAY proposals — auto-applyable: the current keyword has decay
 *     evidence and we have a clearly stronger alternative.
 *   • OPPORTUNITY proposals — preview only: the alternative is better
 *     but the user should accept the swap explicitly.
 *
 * Scoring is intentionally deterministic — every signal that goes into
 * the proposal is reported back so the UI popover can explain the
 * recommendation field-by-field.
 */
import { AstroMcpClient, type AstroMcpClientConfig } from "./AstroMcpClient";
import type {
  AstroKeywordSuggestion,
  AstroCompetitorKeyword,
  AstroTrackedKeyword,
  AstroAddKeywordsResult,
} from "./AstroMcpClient";
import { localeLanguageMultiplier, multiWordBoost } from "../scoring/multipliers";

// Re-export for consumers that import locale-language-multiplier from
// the research surface (back-compat after the 2026-05 scoring
// unification moved the function to scoring/multipliers).
export { localeLanguageMultiplier };

// ── AI enricher hook ─────────────────────────────────────────────────

/** Context passed to the optional AI enricher. The host (worker) uses
 *  this to build an AI prompt that transcreates Astro's monolingual
 *  English candidate pool into locale-relevant alternatives. */
export interface AiEnricherInput {
  app: { appName: string; primaryGenre: string | null; bundleId: string };
  /** Apple storefront — lowercase, e.g. `cz`, `tr`. */
  storeCode: string;
  /** Locale code with region when available, e.g. `cs-CZ`. */
  localeCode: string;
  /** Top Astro candidates as the AI's seed pool. The AI may translate /
   *  adapt these or generate fresh locale-relevant terms. */
  astroSeeds: { keyword: string; popularity: number | null }[];
  /** User's already-tracked keywords for this territory — the AI must
   *  NOT duplicate these. */
  existingKeywords: string[];
  /** Target number of locale-language candidates to produce. */
  count: number;
}

export interface AiEnricherOutput {
  candidates: {
    keyword: string;
    /** Optional 0-100 popularity / impact estimate from the model. */
    popularity?: number | null;
    /** Cluster label — defaults to "LOCALE_AI" when omitted. */
    cluster?: string | null;
    /** Plain-English reason the AI picked this term. Surfaced in the UI. */
    reason?: string | null;
  }[];
}

export type AiEnricher = (input: AiEnricherInput) => Promise<AiEnricherOutput>;

/** Input for the AI relevance scorer — rates how well each candidate
 *  fits THIS app's actual game/category. Astro's mining is keyword-
 *  driven and pulls in candidates from unrelated app categories
 *  (photo collage apps, credit card apps, sniper games — anything
 *  that happens to use the seed term). The scorer drops those by
 *  context. */
export interface AiRelevanceScorerInput {
  app: { appName: string; primaryGenre: string | null; bundleId: string };
  /** Locale code (cs-CZ, en-US, ja). */
  localeCode: string;
  /** Astro storefront (cz, us, jp). */
  storeCode: string;
  /** Current locale's metadata for app context — title + subtitle +
   *  description give the model the actual product. */
  currentMetadata?: {
    title: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    description: string | null;
  };
  /** Cross-locale metadata bundle — when set, takes priority over
   *  `currentMetadata`. Gives the scorer a global view of how the
   *  app pitches itself across markets so candidates are graded
   *  against the union of all locale claims (a candidate matching
   *  the en-US tagline is relevant in tr-TR too). */
  allLocalesMetadata?: {
    locale: string;
    isPrimary: boolean;
    title: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    promotionalText: string | null;
    description: string | null;
  }[];
  /** Candidates with their (real Apple) popularity + difficulty so the
   *  model can weight relevance against demand. */
  candidates: {
    keyword: string;
    popularity: number | null;
    difficulty: number | null;
  }[];
}

export interface AiRelevanceScorerOutput {
  scores: {
    keyword: string;
    /** 0-100 fit to the app. 90+ describes the mechanic; 70-89 same
     *  genre; 40-69 adjacent/generic; <40 unrelated category. */
    relevance: number;
    reason?: string | null;
  }[];
}

export type AiRelevanceScorer = (
  input: AiRelevanceScorerInput,
) => Promise<AiRelevanceScorerOutput>;

// ── Inputs ────────────────────────────────────────────────────────────

/** Minimal slice of an app we need for autopilot. */
export interface AutopilotApp {
  /** Internal id (used to identify back to our DB). */
  id: string;
  appName: string;
  bundleId: string;
  store: "ios" | "android";
  /** App Store Connect / Google Play numeric id when known. */
  storeAppId?: string | null;
}

/** A keyword we currently track for the user, with its latest signal. */
export interface LocalTrackedKeyword {
  id: string;
  keyword: string;
  territory: string;
  /** 0..1 composite score from local scoring. */
  score: number | null;
  /** Bucket from local scoring. DECAY / NEUTRAL / OPPORTUNITY / RISING / CHAMPION. */
  bucket: string | null;
  /** App Store rank, null when off top-50. */
  rank: number | null;
  /** Whether this keyword token is currently live in the locale's
   *  metadata keywords field. */
  inField: boolean;
  /** Latest Astro popularity (0–100). Apple's real search index. */
  volume?: number | null;
  /** Latest Astro 0–100 keyword difficulty. */
  difficulty?: number | null;
  /** Latest Astro max reach chance — impressions if ranked #1. */
  maxReachChance?: number | null;
}

export interface ProposeSwapsOptions {
  /** Storefront / country code (US, GB, TR, …). REQUIRED. */
  territory: string;
  /** Maximum number of proposals to return. Defaults to 20. */
  maxProposals?: number;
  /** Hard cap on how many DECAY auto-swaps we'll surface. Defaults to 10. */
  maxAutoSwaps?: number;
  /** Minimum strength delta (newScore - oldScore) for a proposal to be
   *  surfaced as OPPORTUNITY. Defaults to 0.10. */
  minStrengthDelta?: number;
  /** Mine competitor keywords via Astro's `extract_competitors_keywords`
   *  tool. Up to 5 extra calls per territory — pricey when running
   *  across many storefronts. Defaults to false; set true for primary-
   *  locale analyses where the deeper signal is worth the rate budget. */
  includeCompetitorMining?: boolean;
  /** Locale code (e.g. "cs-CZ", "ja", "tr-TR") used by the candidate
   *  scorer to apply a per-language preference. Czech locales prefer
   *  Czech-diacritic words; Japanese locales prefer kana; Cyrillic
   *  locales prefer Cyrillic. Without this hint we'd recommend English
   *  game words to Czech users. Defaults to the territory code if
   *  unset (e.g. "CZ" → "cs" via lowercase + heuristic). */
  localeHint?: string;
  /** Optional AI enricher — same contract as on AnalyzeOptions.
   *  When set AND the locale isn't English, the autopilot calls this
   *  to transcreate Astro's pool into locale-language candidates. */
  aiEnricher?: AiEnricher;
  /** App context required by the AI enricher. Optional otherwise. */
  appContext?: { primaryGenre: string | null };
  /** Enrich top candidates with real Apple popularity + difficulty by
   *  batch-pushing them through `add_keywords`. Highly recommended —
   *  competitor mining returns a frequency-based "popularity" that
   *  isn't Apple's actual search index, and difficulty is missing
   *  entirely. Enabling this costs ONE extra Astro call per locale
   *  and unlocks realistic filtering. Default true. */
  enrichWithMetrics?: boolean;
  /** Lower bound on enriched Apple popularity. Candidates below this
   *  are filtered. Default 25 (skip dead-tail terms). */
  minPopularity?: number;
  /** Upper bound on enriched Apple difficulty. Candidates above this
   *  are filtered. Default 60 (only winnable terms surface). */
  maxDifficulty?: number;
  /** Cap how many candidates we send to `add_keywords` for enrichment.
   *  Astro charges ONE call per locale regardless of batch size, so
   *  this is just about result-list manageability. Default 25. */
  maxCandidatesToEnrich?: number;
  /** AI relevance scorer — drops candidates that came from unrelated
   *  app categories (e.g. "saw → sniper games" for a block-breaker
   *  app). Without this filter the surfaced proposals can be
   *  technically high-popularity but semantically wrong. */
  aiRelevanceScorer?: AiRelevanceScorer;
  /** Drop candidates with AI relevance below this threshold. Default 40
   *  — anything <40 is "unrelated app category". */
  minRelevance?: number;
  /** Current locale metadata, forwarded to the AI relevance scorer so
   *  the model has actual product context (not just app name). */
  currentMetadata?: AiRelevanceScorerInput["currentMetadata"];
  /** Per-tenant learned noise terms — candidates the user has
   *  explicitly rejected ≥ 3 times as irrelevant. Filtered out
   *  before AI scoring (saves AI cost) AND before final ranking.
   *  Lowercased; equality match, not substring. */
  learnedNoiseTerms?: ReadonlySet<string>;
  /** Extra mining seeds derived from THIS app's metadata (title,
   *  subtitle, description tokens for this locale). Folded into the
   *  seed pool so Astro mining works even when the app has zero
   *  tracked keywords in this territory. Without this, a fresh app
   *  with no keyword history gets zero suggestions. Lowercased,
   *  deduped, 2-30 chars each. */
  appMetadataSeeds?: string[];
}

// ── Outputs ───────────────────────────────────────────────────────────

/**
 * Three flavours of proposal:
 *   • DECAY_AUTO          — weak field token is DECAY, candidate strong; safe
 *                            for batch auto-application (the bulk button is
 *                            deprecated but the label is still useful in the
 *                            UI to flag "low risk").
 *   • OPPORTUNITY_PREVIEW — weak field token exists (NEUTRAL / low-CHAMPION)
 *                            and candidate clearly outscores it; user reviews.
 *   • OPPORTUNITY_NEW     — no weak counterpart. Candidate is an "always-on"
 *                            app-relevant suggestion the user can add (not
 *                            swap). Surfaced even when the field has zero
 *                            DECAY keywords — so the panel is NEVER empty
 *                            when Astro has anything relevant for the app.
 */
export type ProposalKind = "DECAY_AUTO" | "OPPORTUNITY_PREVIEW" | "OPPORTUNITY_NEW";

export interface SwapProposal {
  /** What we're replacing. Null when the candidate is an addition,
   *  not a swap (no weak counterpart to drop). */
  weak: {
    trackedKeywordId: string;
    keyword: string;
    score: number | null;
    bucket: string | null;
    rank: number | null;
  } | null;
  /** The stronger candidate we recommend. */
  strong: {
    keyword: string;
    /** 0..1 composite. */
    predictedScore: number;
    /** Where this candidate came from. */
    sources: ("astro_suggestion" | "astro_competitor" | "astro_ranking")[];
    /** Astro raw signals — may be partial. */
    astro: {
      popularity: number | null;
      volume: number | null;
      maxVolume: number | null;
      difficulty: number | null;
      maxReachChance: number | null;
    };
    /** Optional cross-signal cluster label / reason Astro attached. */
    cluster?: string | null;
    reason?: string | null;
  };
  /** Verdict — auto-swap (DECAY) vs human-preview (OPPORTUNITY). */
  kind: ProposalKind;
  /** newScore - oldScore. Always present, > 0 for surfaced proposals. */
  scoreDelta: number;
  /** Plain-English explanation. */
  rationale: string;
}

export interface ProposeSwapsResult {
  territory: string;
  proposals: SwapProposal[];
  /** Diagnostic snapshot — useful for the UI explainer. */
  diagnostics: {
    weakCandidateCount: number;
    strongCandidateCount: number;
    suggestionSampleCount: number;
    competitorSampleCount: number;
  };
}

export interface SyncResult {
  astroAppId: string | null;
  added: number;
  skipped: number;
  skippedKeywords: string[];
  /** How many chunks (≤100 each) we sent to Astro. */
  chunks: number;
}

export interface AnalyzeOptions {
  /** Storefronts to analyse. Required — Astro tracking + suggestions
   *  are country-scoped, so we always run per-territory. */
  territories: string[];
  /** Optional territory → locale code map (e.g. `CZ → cs-CZ`). When
   *  set, the candidate scorer applies a per-language preference so
   *  Czech locales prefer Czech-diacritic words, Japanese locales
   *  prefer kana, etc. Falls back to a territory heuristic when a
   *  territory isn't in the map. */
  territoryLocaleMap?: Record<string, string>;
  /** Optional AI enricher — called per territory with the raw Astro
   *  candidate pool when the locale is non-English. Allows the host
   *  (worker) to plug in an AI orchestrator that transcreates the
   *  English-dominant Astro pool into locale-language alternatives.
   *
   *  The autopilot doesn't import an AI provider directly to keep
   *  the package dependency-free; the worker wraps `loadAiOrchestrator`
   *  and passes a closure here. */
  aiEnricher?: AiEnricher;
  /** Forward `enrichWithMetrics` to every per-territory proposeSwaps call. */
  enrichWithMetrics?: boolean;
  /** Realistic-target filter: popularity ≥ this value. Default 25. */
  minPopularity?: number;
  /** Realistic-target filter: difficulty ≤ this value. Default 60. */
  maxDifficulty?: number;
  /** AI relevance scorer — see ProposeSwapsOptions.aiRelevanceScorer. */
  aiRelevanceScorer?: AiRelevanceScorer;
  /** AI relevance threshold (default 40). */
  minRelevance?: number;
  /** Map locale → current metadata snapshot. Used by the relevance
   *  scorer so the AI sees the actual product copy for context, not
   *  just the app name. */
  currentMetadataByLocale?: Record<
    string,
    AiRelevanceScorerInput["currentMetadata"]
  >;
  /** Per-territory proposal cap. Default 12. */
  maxProposalsPerLocale?: number;
  /** Per-territory DECAY auto-swap cap. Default 6. */
  maxAutoSwapsPerLocale?: number;
  /** Score-delta cutoff for OPPORTUNITY_PREVIEW. Default 0.10. */
  minStrengthDelta?: number;
  /** Mine competitor keywords via `extract_competitors_keywords` for
   *  the strongest tracked terms in each territory. Up to ~5 calls
   *  PER TERRITORY — extremely fast to blow through Astro's rate limit
   *  on multi-locale apps. Default: false.
   *
   *  Recommend turning this on only for primary-locale analyses or
   *  when the user explicitly opts into a "deep" run. */
  includeCompetitorMining?: boolean;
  /** Skip territories with zero tracked keywords. Default true —
   *  there's nothing to compare against and the call would just burn
   *  rate-limit budget. */
  skipEmptyTerritories?: boolean;
  /** Per-tenant learned noise — forwarded to every per-territory
   *  proposeSwaps call. Worker pulls this from LearnedNoiseTerm
   *  before analyze starts. */
  learnedNoiseTerms?: ReadonlySet<string>;
  /** Per-locale (or per-territory) mining seeds drawn from THIS app's
   *  metadata — title / subtitle / description tokens. Keyed by locale
   *  code when available, falling back to territory code. The worker
   *  builds these from AppLocalization rows so Astro mining always
   *  has app-relevant seeds, even when the app has zero tracked
   *  keywords in this storefront (fresh onboarding).
   *
   *  Without this, the seed pool is starved on new apps and the
   *  proposals panel comes back empty — the exact failure mode users
   *  hit before this was wired in. */
  appMetadataSeedsByLocale?: Record<string, string[]>;
  /** Optional per-territory progress hook. Called BEFORE each
   *  territory's work starts; the autopilot processes territories
   *  sequentially so the index is monotonic. The worker uses this to
   *  emit Job progress updates the UI can poll. */
  onTerritoryStart?: (info: {
    index: number;
    total: number;
    territory: string;
  }) => Promise<void> | void;
}

/** End-to-end result for the autopilot's single-call "smart sync"
 *  flow: registers the app, pushes our keywords per territory, then
 *  mines proposals from Astro. The UI renders this directly. */
export interface AnalyzeResult {
  astroAppId: string | null;
  syncByTerritory: {
    territory: string;
    added: number;
    skipped: number;
    skippedKeywords: string[];
    /** Set when the per-territory sync failed; recommendations still
     *  ran with whatever Astro already knew about this app. */
    error?: string;
  }[];
  recommendationsByTerritory: ProposeSwapsResult[];
  totals: {
    added: number;
    skipped: number;
    proposals: number;
    autoSwaps: number;
    opportunities: number;
  };
  /** Wall-clock duration of the entire orchestration. */
  durationMs: number;
}

// ── Scoring constants ────────────────────────────────────────────────

const DEFAULT_MIN_STRENGTH_DELTA = 0.1;
const DEFAULT_MAX_PROPOSALS = 20;
const DEFAULT_MAX_AUTO_SWAPS = 10;

/** Components when an Astro suggestion has Astro signals attached. */
const W_APPLE_POP = 0.25;
const W_VOLUME = 0.25;
const W_DIFFICULTY_INV = 0.25;
const W_REACH = 0.15;
const W_CLUSTER_BONUS = 0.10;

const CLUSTER_BONUS: Record<string, number> = {
  PAINKILLER: 1.0,
  LONG_TAIL: 0.7,
  COMPETITOR: 0.6,
  COMPETITOR_BORROW: 0.6,
  SYNONYM: 0.5,
  BRAND: 0.4,
  CORE: 0.7,
  // AI transcreated for the locale's language — strong bonus because
  // these were generated explicitly to fit the locale that Astro can't
  // serve from its mining data.
  LOCALE_AI: 0.95,
};

// ── Service ──────────────────────────────────────────────────────────

export class AstroAutopilot {
  private readonly _client: AstroMcpClient;

  constructor(config: AstroMcpClientConfig | { client: AstroMcpClient }) {
    this._client = "client" in config ? config.client : new AstroMcpClient(config);
  }

  /** Underlying Astro MCP client. Exposed so callers (the worker's
   *  signal-persistence step, the keyword-detail popover) can run
   *  ad-hoc tool calls — `getAppKeywords`, `searchRankings` — without
   *  spinning up a parallel connection that wouldn't share this
   *  instance's rate-limiter. Keep usage thin: anything stateful
   *  (rate-limit retry, error containment) should live on a method
   *  here, not be re-invented in callers. */
  get client(): AstroMcpClient {
    return this._client;
  }

  /** Idempotent: registers the app with Astro if not already there.
   *  Returns the Astro-side appId (when Astro echoes one) or null when
   *  Astro returns a confirmation without an id. */
  /** Fetch the app's current rank + position history for ONE keyword
   *  in ONE storefront. Goes through the rate-limiter that the
   *  analyze worker shares, so popover usage doesn't starve a running
   *  multi-locale autopilot job. */
  async getKeywordRankings(params: {
    keyword: string;
    store: string;
    includeHistory?: boolean;
  }): Promise<
    | {
        rank: number | null;
        previousRank: number | null;
        popularity: number | null;
        difficulty: number | null;
        history: { date: string; ranking: number | null }[];
        capturedAt: string | null;
      }
    | null
  > {
    const samples = await this._client.searchRankings({
      keyword: params.keyword,
      store: params.store,
      includeHistory: params.includeHistory ?? true,
    });
    const sample = samples[0];
    if (!sample) return null;
    return {
      rank: sample.rank ?? null,
      previousRank: sample.previousRank ?? null,
      popularity: sample.popularity ?? null,
      difficulty: sample.difficulty ?? null,
      history: sample.history ?? [],
      capturedAt: sample.capturedAt ?? null,
    };
  }

  async ensureAppTracked(app: AutopilotApp): Promise<string | null> {
    // First try by App Store id — that's the most reliable lookup key.
    if (!app.storeAppId) {
      throw new Error(
        "AstroAutopilot.ensureAppTracked requires storeAppId — Astro identifies apps by App Store numeric id.",
      );
    }
    const result = await this._client.addApp({ appStoreId: app.storeAppId });
    return result.app?.id ?? app.storeAppId;
  }

  /** Push the user's tracked keywords up to Astro so Astro can use them
   *  as a tracking anchor + suggest neighbours.
   *
   *  IMPORTANT: this method pushes to a SINGLE storefront, not the
   *  whole app. Pass `store` = lowercase storefront code. Returns
   *  SyncResult — empty + skipped=0 when nothing to push. */
  async syncKeywords(
    app: AutopilotApp,
    keywords: string[],
    store: string,
  ): Promise<SyncResult> {
    const astroAppId = await this.ensureAppTracked(app);
    if (!astroAppId) {
      throw new Error("Astro did not return an appId for the app");
    }
    if (keywords.length === 0) {
      return { astroAppId, added: 0, skipped: 0, skippedKeywords: [], chunks: 0 };
    }
    // Deduplicate + normalise — Astro is case-insensitive but we'd
    // rather not waste batch slots on duplicate variants.
    const unique = uniqueNormalised(keywords);
    const chunks = chunk(unique, 100);
    const aggregate: AstroAddKeywordsResult = {
      added: 0,
      skipped: 0,
      skippedKeywords: [],
      results: [],
    };
    for (const c of chunks) {
      const r = await this._client.addKeywords({
        appId: astroAppId,
        store: store.toLowerCase(),
        keywords: c,
      });
      aggregate.added += r.added;
      aggregate.skipped += r.skipped;
      aggregate.skippedKeywords.push(...r.skippedKeywords);
    }
    return {
      astroAppId,
      added: aggregate.added,
      skipped: aggregate.skipped,
      skippedKeywords: aggregate.skippedKeywords,
      chunks: chunks.length,
    };
  }

  /**
   * Produce ranked weak → strong swap proposals for one territory.
   *
   * Strategy:
   *
   *   1. Score every currently-tracked keyword using the local signals.
   *      Sort ascending — these are the WEAK candidates we'd swap out
   *      (preference goes to DECAY rows first, then NEUTRAL < 0.3, then
   *      anything below the local average).
   *
   *   2. Gather STRONG candidates from Astro:
   *        a. Run `get_keyword_suggestions` once for the app.
   *        b. For up to 5 of the user's CHAMPION terms, run
   *           `extract_competitors_keywords` to mine related winners.
   *        c. Optionally, ask `search_rankings` to enrich top suggestions
   *           with country-specific metrics. (Skipped here to keep the
   *           call count manageable — the autopilot is preview-first.)
   *
   *   3. Score each strong candidate using the available Astro signals
   *      (cluster bonus, popularity, volume, difficulty inversion,
   *      reach). Drop those that score ≤ the weakest local row's score
   *      + minStrengthDelta — there's no upside to surfacing them.
   *
   *   4. Pair weak vs strong by score-delta DESC. The top
   *      maxAutoSwaps pairs whose weak side is DECAY become DECAY_AUTO;
   *      the rest become OPPORTUNITY_PREVIEW. Cap total at maxProposals.
   */
  async proposeSwaps(
    app: AutopilotApp,
    localTracked: LocalTrackedKeyword[],
    opts: ProposeSwapsOptions,
  ): Promise<ProposeSwapsResult> {
    const territory = opts.territory.toUpperCase();
    const maxProposals = opts.maxProposals ?? DEFAULT_MAX_PROPOSALS;
    const maxAutoSwaps = opts.maxAutoSwaps ?? DEFAULT_MAX_AUTO_SWAPS;
    const minStrengthDelta = opts.minStrengthDelta ?? DEFAULT_MIN_STRENGTH_DELTA;

    const inTerritory = localTracked.filter(
      (k) => k.territory.toUpperCase() === territory,
    );

    // ── Step 1: rank weak local rows ──────────────────────────────
    const weak = pickWeakCandidates(inTerritory);

    // ── Step 2: gather strong candidates from Astro ───────────────
    // Astro identifies apps by App Store numeric id and storefronts
    // by lowercase country code (Apple-style "us", "tr", …).
    if (!app.storeAppId) {
      return {
        territory,
        proposals: [],
        diagnostics: {
          weakCandidateCount: weak.length,
          strongCandidateCount: 0,
          suggestionSampleCount: 0,
          competitorSampleCount: 0,
        },
      };
    }
    const storeCode = territory.toLowerCase();

    // ── Step 2a: ask Astro what it ACTUALLY has tracked for this
    // (app, store) pair. This is the source of truth — `add_keywords`
    // distributes our local keywords across stores in ways we can't
    // perfectly predict, and mining requires the seed term to be
    // tracked. Picking seeds from Astro's own list guarantees the
    // `extract_competitors_keywords` calls actually return data.
    const astroTracked = await safeCall(() =>
      this._client.getAppKeywords({ appId: app.storeAppId! }),
    );
    const trackedInStore = astroTracked.filter(
      (k) => (k.country ?? "").toLowerCase() === storeCode,
    );

    // ── Step 2b: AI suggestions — Astro's `get_keyword_suggestions`
    // tool. We still ask, but expect it to return empty often (Astro's
    // own observation is that the suggestion engine is sparse). Mining
    // (Step 2c) is the real recommendation engine.
    const suggestions = await safeCall(() =>
      this._client.getKeywordSuggestions({
        appId: app.storeAppId!,
        store: storeCode,
      }),
    );

    // ── Step 2c: competitor mining — TWO seed sources, ordered by
    // intent specificity:
    //
    //   1. Each WEAK keyword in this territory — the most semantically
    //      relevant seed possible. Mining for "hlavolam" returns the
    //      competitor cluster for that specific intent, in that store,
    //      so results stay locale-aware (Czech competitors who rank
    //      for "hlavolam" naturally use Czech).
    //   2. Top-popularity Astro-tracked terms — broad fallback when
    //      weak-side mining returns sparse data (Astro often returns
    //      404 for niche / locale-specific seeds).
    //
    // Cap total seeds to keep Astro's rate-limit budget reasonable.
    const weakSeedsRaw = weak
      .filter((w) => w.keyword.trim().length > 0)
      .slice(0, 5)
      .map((w) => w.keyword);
    const popularSeeds = pickAstroMiningSeeds(trackedInStore, inTerritory, 3).map(
      (s) => s.keyword,
    );
    // App-metadata-derived seeds — title / subtitle / description tokens
    // for THIS locale. These are crucial when the app has zero tracked
    // keywords (fresh onboarding) or all-CHAMPION keywords (no weak
    // anchors). Without them, mining is starved.
    const metadataSeeds = (opts.appMetadataSeeds ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2 && s.length <= 30)
      .slice(0, 6);
    const mineSeeds = uniqueNormalised([
      ...weakSeedsRaw,
      ...popularSeeds,
      ...metadataSeeds,
    ]).slice(0, 12);

    const competitorWaves =
      opts.includeCompetitorMining === false || mineSeeds.length === 0
        ? []
        : await this.mineCompetitorKeywordsFromSeeds(app, mineSeeds, storeCode);

    const candidatePool = mergeCandidates(suggestions, competitorWaves);
    // Filter out:
    //   • Anything already tracked locally (no duplicate recommendations)
    //   • Universal ASO noise (`game`, `app`, `pro`, `free`, single letters)
    //   • Anything with popularity < 20 (sub-threshold signal, mostly junk)
    const trackedSet = new Set(inTerritory.map((k) => normalise(k.keyword)));
    const hostGenre = opts.appContext?.primaryGenre ?? null;
    // Per-tenant learned noise — terms the user has previously rejected
    // ≥3 times. Filtered out BEFORE AI scoring so we don't spend tokens
    // re-evaluating known-rejected candidates.
    const learnedNoise = opts.learnedNoiseTerms ?? new Set<string>();
    const filteredPool = candidatePool.filter((c) => {
      if (trackedSet.has(normalise(c.keyword))) return false;
      if (isAsoNoiseCandidate(c.keyword, hostGenre)) return false;
      if (learnedNoise.has(normalise(c.keyword))) return false;
      // Drop very-low-popularity candidates ONLY when they came from
      // competitor mining (which returns 0-100). `get_keyword_suggestions`
      // uses a 0-5 scale so a "popularity=4" suggestion is actually
      // high-confidence and must NOT be filtered.
      if (
        c.popularity != null &&
        c.popularity < 20 &&
        c.sources.includes("astro_competitor") &&
        !c.sources.includes("astro_suggestion")
      ) {
        return false;
      }
      return true;
    });

    // ── Step 2d: AI locale enrichment ─────────────────────────────
    // When Astro's pool for a non-English locale is monolingual English
    // (Czech, Polish, Hungarian, etc. all hit this), ask the host's AI
    // orchestrator to transcreate the top seeds into locale-language
    // alternatives. Astro CAN'T translate — its mining is bound to the
    // store's actual top-app metadata. This step closes the gap.
    const localeForAi = opts.localeHint ?? territoryToLocale(territory);
    const aiCandidates =
      opts.aiEnricher && !isEnglishLocale(localeForAi)
        ? await safeAiEnrich(opts.aiEnricher, {
            app: {
              appName: app.appName,
              primaryGenre: opts.appContext?.primaryGenre ?? null,
              bundleId: app.bundleId,
            },
            storeCode,
            localeCode: localeForAi,
            astroSeeds: filteredPool
              .slice(0, 20)
              .map((c) => ({
                keyword: c.keyword,
                popularity: c.popularity ?? null,
              })),
            existingKeywords: [...trackedSet],
            count: 15,
          })
        : [];

    const enrichedPool: StrongCandidate[] = [
      ...filteredPool,
      ...aiCandidates.filter(
        (c) =>
          !trackedSet.has(normalise(c.keyword)) &&
          !filteredPool.some(
            (p) => normalise(p.keyword) === normalise(c.keyword),
          ) &&
          !isAsoNoiseCandidate(c.keyword, hostGenre) &&
          !learnedNoise.has(normalise(c.keyword)),
      ),
    ];

    // ── Step 2e: enrich top candidates with REAL Apple metrics ────
    // `extract_competitors_keywords` returns a competitor-frequency
    // "popularity" that is NOT Apple's actual search index, and no
    // difficulty at all. We push the top candidates through
    // `add_keywords` — Astro tracks them AND returns the true Apple
    // popularity + difficulty per keyword in the results[] array.
    // One Astro call enriches up to 100 candidates. Cheap and HUGELY
    // improves the realistic-target filter that comes next.
    const minPop = opts.minPopularity ?? 25;
    const maxDiff = opts.maxDifficulty ?? 60;
    const enrichMax = opts.maxCandidatesToEnrich ?? 25;
    const enrichWithMetrics = opts.enrichWithMetrics ?? true;
    if (enrichWithMetrics && app.storeAppId && enrichedPool.length > 0) {
      // Take the most popular (competitor-frequency) candidates as the
      // enrichment batch — those are the ones the user is most likely
      // to see surface, so we want their real Apple numbers most.
      const sortedForEnrich = [...enrichedPool]
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
        .slice(0, enrichMax)
        .map((c) => c.keyword);
      try {
        const enrichResult = await this._client.addKeywords({
          appId: app.storeAppId,
          store: storeCode,
          keywords: sortedForEnrich,
        });
        // Map: lowercase keyword → real Apple metrics
        const metrics = new Map<
          string,
          { popularity: number | null; difficulty: number | null; ranking: number | null }
        >();
        for (const r of enrichResult.results) {
          metrics.set(normalise(r.keyword), {
            popularity: r.popularity,
            difficulty: r.difficulty,
            ranking: r.ranking,
          });
        }
        // Patch the pool in place — replace competitor-frequency
        // popularity with real Apple popularity, attach Apple difficulty.
        // Mark the candidate as enriched so the filter knows to use it.
        for (const c of enrichedPool) {
          const m = metrics.get(normalise(c.keyword));
          if (m) {
            if (m.popularity != null) c.popularity = m.popularity;
            if (m.difficulty != null) c.difficulty = m.difficulty;
            c.enrichedWithAppleMetrics = true;
          }
        }
      } catch {
        // Enrichment failure is non-fatal — we just fall back to the
        // competitor-frequency popularity and skip the difficulty filter.
      }
    }

    // Apply the realistic-target filter ONLY to enriched candidates.
    // Competitor-frequency popularity and AI predictedRelevance use
    // different scales — applying an absolute Apple-popularity floor
    // to them would incorrectly cut valid candidates.
    const realisticPool = enrichedPool.filter((c) => {
      if (!c.enrichedWithAppleMetrics) return true;
      if (c.popularity != null && c.popularity < minPop) return false;
      if (c.difficulty != null && c.difficulty > maxDiff) return false;
      return true;
    });

    // ── Step 2f: AI relevance filter ──────────────────────────────
    // Astro's mining returns candidates from any app that ranks for
    // the seed keyword — including totally unrelated categories
    // (photo collage, credit card, sniper games for a block-breaker
    // app). Without this filter the surfaced swaps look generic /
    // bizarre. The AI rates each candidate's fit to THIS app and
    // we drop low-relevance ones.
    const minRelevance = opts.minRelevance ?? 40;
    const relevanceMap = new Map<string, number>();
    if (opts.aiRelevanceScorer && realisticPool.length > 0) {
      try {
        const out = await opts.aiRelevanceScorer({
          app: {
            appName: app.appName,
            primaryGenre: opts.appContext?.primaryGenre ?? null,
            bundleId: app.bundleId,
          },
          localeCode: localeForAi,
          storeCode,
          ...(opts.currentMetadata && { currentMetadata: opts.currentMetadata }),
          candidates: realisticPool.slice(0, 40).map((c) => ({
            keyword: c.keyword,
            popularity: c.popularity,
            difficulty: c.difficulty,
          })),
        });
        for (const s of out.scores) {
          relevanceMap.set(normalise(s.keyword), s.relevance);
        }
      } catch {
        // Scorer failure is non-fatal — fall back to no relevance
        // filter so we still surface SOME proposals.
      }
    }
    // Apply the relevance filter. Candidates the scorer didn't rate
    // (outside the top 40 we sent) keep a neutral relevance and bypass.
    const relevantPool = realisticPool.filter((c) => {
      const rel = relevanceMap.get(normalise(c.keyword));
      if (rel == null) return true; // not scored → keep
      return rel >= minRelevance;
    });

    // Score each candidate using the locale's expected language. This
    // applies a multiplier in [0.45, 1.10] so Czech locales prefer
    // Czech-diacritic words, Japanese locales prefer kana, etc.
    // Relevance score (when present) multiplies the composite — so a
    // 95-relevance candidate beats a 50-relevance candidate at the
    // same popularity / difficulty.
    const scoredStrong = relevantPool
      .map((c) => {
        const rel = relevanceMap.get(normalise(c.keyword));
        const baseScore = scoreAstroCandidate(c, localeForAi);
        // Relevance multiplier: 100 → ×1.20, 70 → ×1.05, 50 → ×0.95,
        // 40 → ×0.85. Candidates not scored bypass the multiplier.
        const relMul = rel == null ? 1 : 0.7 + (rel / 100) * 0.5;
        return {
          candidate: c,
          score: clamp01(baseScore * relMul),
          relevance: rel ?? null,
        };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // ── Step 3 + 4: build proposals ───────────────────────────────
    //
    // Two-pass strategy:
    //   Pass 1 — pair up to `weak.length` strong candidates with the
    //            weakest in-field tokens (the original "swap" path).
    //            Gate by minStrengthDelta so we never propose a swap
    //            that's not actually a meaningful score uplift.
    //   Pass 2 — emit remaining strong candidates as OPPORTUNITY_NEW
    //            (no weak counterpart). NO delta gate here — these are
    //            fresh additions, not replacements, so what matters is
    //            their absolute relevance + composite score.
    //
    // This guarantees the panel is NEVER empty when Astro has anything
    // app-relevant: even an all-CHAMPION field gets "you could also
    // try…" suggestions instead of the dreaded "field is balanced"
    // dead-end.
    const proposals: SwapProposal[] = [];
    const used = new Set<string>();
    let weakCursor = 0;
    let autoSwapsLeft = maxAutoSwaps;

    // Pass 1: swap pairs (weak → strong)
    for (const strong of scoredStrong) {
      if (proposals.length >= maxProposals) break;
      if (weakCursor >= weak.length) break; // no more weaks → leave the rest for Pass 2
      const w = weak[weakCursor];
      if (!w) break;
      const newScore = strong.score;
      const oldScore = w.score ?? 0;
      const delta = newScore - oldScore;
      if (delta < minStrengthDelta) continue;

      const isDecay = w.bucket === "DECAY";
      const kind: ProposalKind =
        isDecay && autoSwapsLeft > 0 ? "DECAY_AUTO" : "OPPORTUNITY_PREVIEW";
      if (kind === "DECAY_AUTO") autoSwapsLeft -= 1;

      proposals.push({
        weak: {
          trackedKeywordId: w.id,
          keyword: w.keyword,
          score: w.score,
          bucket: w.bucket,
          rank: w.rank,
        },
        strong: {
          keyword: strong.candidate.keyword,
          predictedScore: round3(newScore),
          sources: strong.candidate.sources,
          astro: {
            popularity: strong.candidate.popularity,
            volume: strong.candidate.volume,
            maxVolume: strong.candidate.maxVolume,
            difficulty: strong.candidate.difficulty,
            maxReachChance: strong.candidate.maxReachChance,
          },
          cluster: strong.candidate.cluster,
          reason: strong.candidate.reason,
        },
        kind,
        scoreDelta: round3(delta),
        rationale: renderRationale(strong, w, kind),
      });
      used.add(strong.candidate.keyword.toLowerCase());
      weakCursor += 1;
    }

    // Pass 2: opportunity_new (fresh additions). No weak counterpart,
    // no delta gate — just the top remaining app-relevant candidates.
    // Cap at half the total proposal budget so swap pairs always have
    // room to come back when the field gets unhealthy.
    const opportunityBudget = Math.max(
      1,
      Math.ceil((maxProposals - proposals.length) / 1), // use the rest of the budget
    );
    let opportunitySlots = opportunityBudget;
    for (const strong of scoredStrong) {
      if (opportunitySlots <= 0) break;
      if (proposals.length >= maxProposals) break;
      const kw = strong.candidate.keyword.toLowerCase();
      if (used.has(kw)) continue;
      proposals.push({
        weak: null,
        strong: {
          keyword: strong.candidate.keyword,
          predictedScore: round3(strong.score),
          sources: strong.candidate.sources,
          astro: {
            popularity: strong.candidate.popularity,
            volume: strong.candidate.volume,
            maxVolume: strong.candidate.maxVolume,
            difficulty: strong.candidate.difficulty,
            maxReachChance: strong.candidate.maxReachChance,
          },
          cluster: strong.candidate.cluster,
          reason: strong.candidate.reason,
        },
        kind: "OPPORTUNITY_NEW",
        scoreDelta: round3(strong.score), // absolute, not a delta
        rationale: renderRationale(strong, null, "OPPORTUNITY_NEW"),
      });
      used.add(kw);
      opportunitySlots -= 1;
    }

    return {
      territory,
      proposals,
      diagnostics: {
        weakCandidateCount: weak.length,
        strongCandidateCount: scoredStrong.length,
        suggestionSampleCount: suggestions.length,
        competitorSampleCount: competitorWaves.length,
      },
    };
  }

  /**
   * Smart end-to-end sync: registers the app in Astro, pushes our
   * tracked keywords per territory (chunked ≤100), then mines
   * recommendations from Astro. Per-territory failures are isolated —
   * a Turkish-locale sync error doesn't prevent US recommendations.
   *
   * This is the single call the UI's "Analyze with Astro" button
   * makes. It replaces the previous two-step "Sync to Astro" then
   * "Get recommendations" flow.
   */
  async analyze(
    app: AutopilotApp,
    localTracked: LocalTrackedKeyword[],
    opts: AnalyzeOptions,
  ): Promise<AnalyzeResult> {
    const start = Date.now();
    const skipEmpty = opts.skipEmptyTerritories ?? true;
    // Default to TRUE — competitor mining is the real recommendation
    // engine. `get_keyword_suggestions` returns empty arrays for most
    // apps in practice, so without mining we'd ship zero proposals.
    const includeCompetitorMining = opts.includeCompetitorMining ?? true;

    // De-dupe + filter empties up front so we never queue rate-limit
    // budget on territories with nothing to push.
    const allTerritories = [...new Set(opts.territories.map((t) => t.toUpperCase()))];
    const territories = skipEmpty
      ? allTerritories.filter((t) =>
          localTracked.some((k) => k.territory.toUpperCase() === t),
        )
      : allTerritories;

    // Step 1: ensure the app is registered in Astro. Once, regardless
    // of territory count — Astro tracks the app globally and keywords
    // per country. A "Duplicate entry" error is treated as success by
    // the client and falls back to `app.storeAppId`.
    const astroAppId =
      (await safeOptional(() => this.ensureAppTracked(app))) ?? app.storeAppId ?? null;

    // Run sync + propose SEQUENTIALLY per territory. Astro's
    // rate-limit (~30 req/min) means parallel fan-out across many
    // locales just bounces with 429s. The token-bucket limiter on the
    // client side then paces requests within the cap.
    const syncByTerritory: AnalyzeResult["syncByTerritory"] = [];
    const recommendationsByTerritory: ProposeSwapsResult[] = [];

    for (let i = 0; i < territories.length; i += 1) {
      const territory = territories[i]!;
      if (opts.onTerritoryStart) {
        try {
          await opts.onTerritoryStart({
            index: i,
            total: territories.length,
            territory,
          });
        } catch {
          // Progress hook errors must never abort the analysis.
        }
      }
      // ─── push keywords up for THIS territory ────────────────────
      const kws = localTracked
        .filter((k) => k.territory.toUpperCase() === territory)
        .map((k) => k.keyword);
      if (kws.length === 0) {
        syncByTerritory.push({ territory, added: 0, skipped: 0, skippedKeywords: [] });
      } else if (!astroAppId) {
        syncByTerritory.push({
          territory,
          added: 0,
          skipped: 0,
          skippedKeywords: [],
          error: "Astro app not registered — cannot push keywords without an appId.",
        });
      } else {
        try {
          const unique = uniqueNormalised(kws);
          const chunks = chunk(unique, 100);
          let added = 0;
          let skipped = 0;
          const skippedKeywords: string[] = [];
          for (const c of chunks) {
            const r = await this._client.addKeywords({
              appId: astroAppId,
              store: territory.toLowerCase(),
              keywords: c,
            });
            added += r.added;
            skipped += r.skipped;
            skippedKeywords.push(...r.skippedKeywords);
          }
          syncByTerritory.push({ territory, added, skipped, skippedKeywords });
        } catch (err) {
          syncByTerritory.push({
            territory,
            added: 0,
            skipped: 0,
            skippedKeywords: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ─── mine proposals for THIS territory ──────────────────────
      try {
        const localeHint = opts.territoryLocaleMap?.[territory];
        // Metadata seeds are keyed by locale primarily, falling back to
        // territory code so callers that don't have an explicit locale
        // map still work.
        const seedKey = localeHint ?? territory;
        const metadataSeeds =
          opts.appMetadataSeedsByLocale?.[seedKey] ??
          opts.appMetadataSeedsByLocale?.[territory] ??
          undefined;
        const r = await this.proposeSwaps(app, localTracked, {
          territory,
          ...(opts.maxProposalsPerLocale !== undefined && {
            maxProposals: opts.maxProposalsPerLocale,
          }),
          ...(opts.maxAutoSwapsPerLocale !== undefined && {
            maxAutoSwaps: opts.maxAutoSwapsPerLocale,
          }),
          ...(opts.minStrengthDelta !== undefined && {
            minStrengthDelta: opts.minStrengthDelta,
          }),
          includeCompetitorMining,
          ...(localeHint && { localeHint }),
          ...(opts.aiEnricher && { aiEnricher: opts.aiEnricher }),
          ...(opts.aiRelevanceScorer && {
            aiRelevanceScorer: opts.aiRelevanceScorer,
          }),
          ...(opts.minRelevance !== undefined && { minRelevance: opts.minRelevance }),
          ...(opts.currentMetadataByLocale?.[
            opts.territoryLocaleMap?.[territory] ?? territory
          ] && {
            currentMetadata:
              opts.currentMetadataByLocale[
                opts.territoryLocaleMap?.[territory] ?? territory
              ],
          }),
          ...(opts.learnedNoiseTerms && {
            learnedNoiseTerms: opts.learnedNoiseTerms,
          }),
          ...(opts.enrichWithMetrics !== undefined && {
            enrichWithMetrics: opts.enrichWithMetrics,
          }),
          ...(opts.minPopularity !== undefined && { minPopularity: opts.minPopularity }),
          ...(opts.maxDifficulty !== undefined && { maxDifficulty: opts.maxDifficulty }),
          ...(metadataSeeds && metadataSeeds.length > 0 && {
            appMetadataSeeds: metadataSeeds,
          }),
        });
        recommendationsByTerritory.push(r);
      } catch {
        recommendationsByTerritory.push({
          territory,
          proposals: [],
          diagnostics: {
            weakCandidateCount: 0,
            strongCandidateCount: 0,
            suggestionSampleCount: 0,
            competitorSampleCount: 0,
          },
        });
      }
    }

    // Aggregate totals for the UI summary stamp.
    const totals = {
      added: syncByTerritory.reduce((s, r) => s + r.added, 0),
      skipped: syncByTerritory.reduce((s, r) => s + r.skipped, 0),
      proposals: 0,
      autoSwaps: 0,
      opportunities: 0,
    };
    for (const r of recommendationsByTerritory) {
      for (const p of r.proposals) {
        totals.proposals += 1;
        if (p.kind === "DECAY_AUTO") totals.autoSwaps += 1;
        else totals.opportunities += 1;
      }
    }

    return {
      astroAppId,
      syncByTerritory,
      recommendationsByTerritory,
      totals,
      durationMs: Date.now() - start,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  /** For up to 5 of the user's strongest tracked keywords, ask Astro
   *  for related competitor terms. Errors per seed don't abort the
   *  whole flow — Astro often returns nothing for niche seeds.
   *
   *  We pick STRONG seeds (score ≥ 0.5 or CHAMPION) because Astro's
   *  competitor mining needs a high-popularity anchor to find real
   *  intent neighbours. If none of the user's keywords qualify yet
   *  (new app, no scoring data) we fall back to the top 5 by score
   *  to give Astro something to work with. */
  /** Run `extract_competitors_keywords` for an explicit list of seeds.
   *  Errors per seed are isolated — Astro often returns 404 for niche
   *  terms, and that's expected. Parallel within a single territory is
   *  fine because the client's rate limiter serialises them. */
  private async mineCompetitorKeywordsFromSeeds(
    app: AutopilotApp,
    seedKeywords: string[],
    store: string,
  ): Promise<AstroCompetitorKeyword[]> {
    if (!app.storeAppId || seedKeywords.length === 0) return [];
    const results = await Promise.all(
      seedKeywords.map((kw) =>
        safeCall(() =>
          this._client.extractCompetitorsKeywords({
            keyword: kw,
            appId: app.storeAppId!,
            store,
          }),
        ),
      ),
    );
    return results.flat();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

interface StrongCandidate {
  keyword: string;
  popularity: number | null;
  volume: number | null;
  maxVolume: number | null;
  difficulty: number | null;
  maxReachChance: number | null;
  cluster: string | null;
  reason: string | null;
  sources: ("astro_suggestion" | "astro_competitor" | "astro_ranking")[];
  /** True ONLY after `add_keywords` overwrote popularity/difficulty
   *  with Apple's actual search-index values. The realistic-target
   *  filter (popularity floor + difficulty ceiling) is meaningful
   *  only on this scale — competitor-frequency popularity and
   *  AI-suggested predictedRelevance use different scales and would
   *  be incorrectly cut by an absolute floor. */
  enrichedWithAppleMetrics?: boolean;
}

function mergeCandidates(
  suggestions: AstroKeywordSuggestion[],
  competitors: AstroCompetitorKeyword[],
): StrongCandidate[] {
  const byKey = new Map<string, StrongCandidate>();

  for (const s of suggestions) {
    const k = normalise(s.keyword);
    if (k.length === 0) continue;
    byKey.set(k, {
      keyword: s.keyword,
      popularity: s.popularity ?? null,
      volume: s.volume ?? null,
      maxVolume: null,
      difficulty: s.difficulty ?? null,
      maxReachChance: s.maxReachChance ?? null,
      cluster: s.cluster ?? null,
      reason: s.reason ?? null,
      sources: ["astro_suggestion"],
    });
  }
  for (const c of competitors) {
    const k = normalise(c.keyword);
    if (k.length === 0) continue;
    const existing = byKey.get(k);
    if (existing) {
      if (existing.popularity == null && c.popularity != null) {
        existing.popularity = c.popularity;
      }
      if (!existing.sources.includes("astro_competitor")) {
        existing.sources.push("astro_competitor");
      }
    } else {
      byKey.set(k, {
        keyword: c.keyword,
        popularity: c.popularity ?? null,
        volume: null,
        maxVolume: null,
        difficulty: null,
        maxReachChance: null,
        cluster: "COMPETITOR_BORROW",
        reason: c.source ?? null,
        sources: ["astro_competitor"],
      });
    }
  }
  return [...byKey.values()];
}

/** Composite score 0..1 for an Astro candidate. Re-normalises weights
 *  across whichever signals are present so a candidate with only
 *  popularity isn't unfairly penalised against one with all four.
 *
 *  Optional `localeHint`: when provided, applies a language-match
 *  multiplier in [0.45, 1.10] so Czech locales prefer Czech-diacritic
 *  words, Cyrillic locales prefer Cyrillic, etc. Astro's mining pool
 *  is mostly English; without this Czech users would see English
 *  replacements for Czech keywords. */
/** Universal ASO noise — terms that surface in EVERY Astro mining
 *  result regardless of seed because they appear in nearly every app's
 *  metadata. Filtering them out removes the "generic English game word"
 *  problem that dominated the Czech locale results.
 *
 *  Kept conservative — only terms with zero niche value. Generic but
 *  category-naming terms (puzzle, idle, brick, ball, race) stay
 *  because they can be legitimate niche markers in the right context. */
const ASO_NOISE_BLOCKLIST = new Set([
  // Generic app market terms
  "game", "games", "app", "apps", "play", "home", "pro", "premium",
  "free", "paid", "fun", "best", "top", "new", "easy", "hd", "lite",
  "edition", "deluxe", "ultra", "plus", "super",
  // Generic verbs/nouns that mean nothing alone
  "time", "life", "live", "video", "sound", "music", "color", "world",
  "story", "click", "tap", "touch", "swipe", "go", "run", "win",
  // App store metadata fillers
  "ai", "robot", "prank", "party", "task", "test", "trial", "daily",
  "flashlight", "fiverr", "pika labs", "ai video",
  // Single letters / numbers
  "a", "b", "c", "d", "e", "i", "n", "o", "s", "x", "z",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
]);

/** App-store top-level categories we care about for cross-category
 *  noise filtering. Apple's genre strings get mapped onto these via
 *  `detectAppCategory`. */
export type AppCategory =
  | "game"
  | "photo"
  | "finance"
  | "health"
  | "medical"
  | "productivity"
  | "utilities"
  | "lifestyle"
  | "weather"
  | "music"
  | "education"
  | "social"
  | "news"
  | "travel"
  | "food"
  | "shopping"
  | "business"
  | "navigation"
  | "books"
  | "sports";

/** Substrings that strongly mark a keyword as belonging to a specific
 *  app category. When the host app's category is X and a candidate
 *  contains a marker for a DIFFERENT category Y, we drop it before
 *  spending AI tokens scoring its relevance. This catches the bulk of
 *  Astro's cross-category bleed cheaply.
 *
 *  Rules:
 *    • Markers must be specific enough that their presence is a strong
 *      signal of category Y. Prefer 2-word phrases (e.g. "photo collage",
 *      "credit card") over generic single words ("photo", "card") that
 *      can legitimately appear in other categories.
 *    • A keyword inside its OWN host category never matches its own
 *      markers (we iterate non-host categories only).
 *    • Within-category subgenre mismatches (e.g. "sniper game" for a
 *      block-breaker game) are NOT handled here — that's what the AI
 *      relevance scorer is for. */
const CATEGORY_MARKERS: Record<AppCategory, readonly string[]> = {
  game: [
    "rpg", "mmo", "mmorpg", "fps game", "shooter game",
    "puzzle game", "platformer", "arcade game", "casino game",
    "slot machine", "match 3", "match-3", "tower defense",
    "battle royale", "io game", "idle game", "clicker game",
    "candy crush", "subway surfers", "royal match", "coin master",
    "brawl stars", "clash royale",
  ],
  photo: [
    "photo editor", "photo collage", "collage maker", "selfie editor",
    "camera filter", "photo filter", "story maker", "reels editor",
    "video editor", "video maker", "filter app", "beauty camera",
  ],
  finance: [
    "credit card", "loan", "mortgage", "tax filing", "budget tracker",
    "investment app", "banking", "wallet app", "crypto wallet",
    "trading app", "stock market", "expense tracker",
  ],
  health: [
    "workout", "fitness", "calorie", "diet plan", "nutrition",
    "yoga app", "meditation", "period tracker", "sleep tracker",
    "step counter", "heart rate", "running tracker",
  ],
  medical: [
    "symptom checker", "doctor finder", "telemedicine",
    "prescription", "blood pressure",
  ],
  productivity: [
    "pdf reader", "pdf editor", "scanner app", "translator app",
    "password manager", "notes app", "todo list", "to-do list",
    "calendar app", "document scanner",
  ],
  utilities: [
    "vpn", "antivirus", "cleaner app", "battery saver",
    "flashlight app", "qr scanner", "system cleaner",
  ],
  lifestyle: [
    "dating app", "horoscope", "astrology", "recipe book", "cookbook",
  ],
  weather: [
    "weather forecast", "weather radar", "rain alert",
    "storm tracker",
  ],
  music: [
    "music maker", "beat maker", "drum machine",
    "guitar tuner", "instrument tuner", "music creation",
    "song maker", "synth app",
  ],
  education: [
    "flashcard", "dictionary app", "language learning",
    "vocabulary trainer", "math solver",
  ],
  social: [
    "messenger app", "chat app", "social network",
    "dating chat",
  ],
  news: [
    "news app", "newspaper", "news reader",
  ],
  travel: [
    "flight booking", "hotel booking", "travel planner",
    "trip planner", "airline ticket",
  ],
  food: [
    "food delivery", "restaurant finder", "menu app",
    "grocery delivery",
  ],
  shopping: [
    "coupon app", "deals app", "shopping list",
  ],
  business: [
    "crm", "invoice maker", "accounting app",
  ],
  navigation: [
    "gps navigation", "offline maps",
  ],
  books: [
    "ebook reader", "audiobook", "comic reader",
  ],
  sports: [
    "live score", "fantasy league", "match schedule",
  ],
};

/** Map Apple's genre name (any variant of "Games", "Photo & Video",
 *  "Finance", "Health & Fitness", "Music", "Education", "Social
 *  Networking", "News", "Travel", "Food & Drink", "Shopping",
 *  "Business", "Navigation", "Books", "Reference", "Utilities",
 *  "Lifestyle", "Weather", "Medical", "Productivity", "Sports", etc.)
 *  onto our internal {@link AppCategory} keys. Returns null for genres
 *  we don't classify ("Entertainment", "Magazines & Newspapers", etc.)
 *  — in that case the cross-category filter is skipped entirely. */
export function detectAppCategory(
  genre: string | null | undefined,
): AppCategory | null {
  if (!genre) return null;
  const g = genre.toLowerCase();
  if (g.includes("game")) return "game";
  if (g.includes("photo") || g.includes("video")) return "photo";
  if (g.includes("finance") || g.includes("banking")) return "finance";
  if (g.includes("medical")) return "medical";
  if (g.includes("health") || g.includes("fitness")) return "health";
  if (g.includes("productivity")) return "productivity";
  if (g.includes("utility") || g.includes("utilities")) return "utilities";
  if (g.includes("weather")) return "weather";
  if (g.includes("music")) return "music";
  if (g.includes("education")) return "education";
  if (g.includes("social")) return "social";
  if (g.includes("news") || g.includes("magazine")) return "news";
  if (g.includes("travel")) return "travel";
  if (g.includes("food") || g.includes("drink")) return "food";
  if (g.includes("shopping")) return "shopping";
  if (g.includes("business")) return "business";
  if (g.includes("navigation")) return "navigation";
  if (g.includes("book")) return "books";
  if (g.includes("sport")) return "sports";
  if (g.includes("lifestyle")) return "lifestyle";
  return null;
}

/** Returns true when the candidate is universal noise OR (when an
 *  app genre is supplied and resolves to a known category) when the
 *  candidate contains markers from a DIFFERENT app category. Used as
 *  the cheap pre-filter before the AI relevance scorer.
 *
 *  Works for any host category — a Finance app drops "workout planner"
 *  and "photo collage" the same way a Game drops "credit card" and
 *  "music maker". Within-category subgenre mismatches are left to the
 *  AI scorer. */
export function isAsoNoiseCandidate(
  keyword: string,
  appGenre?: string | null,
): boolean {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed.length < 3) return true;
  if (ASO_NOISE_BLOCKLIST.has(trimmed)) return true;
  const hostCategory = detectAppCategory(appGenre);
  if (hostCategory) {
    for (const [category, markers] of Object.entries(CATEGORY_MARKERS) as [
      AppCategory,
      readonly string[],
    ][]) {
      if (category === hostCategory) continue;
      for (const marker of markers) {
        if (trimmed.includes(marker)) return true;
      }
    }
  }
  return false;
}

export function scoreAstroCandidate(c: StrongCandidate, localeHint?: string): number {
  const parts: { weight: number; value: number }[] = [];

  if (c.popularity != null) {
    // Astro returns popularity 0-100; Apple Search Ads returns 0-5.
    // We accept either — values > 5 are treated as the 0-100 scale.
    const norm = c.popularity > 5 ? c.popularity / 100 : c.popularity / 5;
    parts.push({ weight: W_APPLE_POP, value: clamp01(norm) });
  }
  if (c.volume != null && c.maxVolume != null && c.maxVolume > 0) {
    parts.push({ weight: W_VOLUME, value: clamp01(c.volume / c.maxVolume) });
  } else if (c.volume != null) {
    // No maxVolume — log-normalise so big absolute volumes still
    // contribute proportionally.
    parts.push({
      weight: W_VOLUME,
      value: clamp01(Math.log10((c.volume ?? 0) + 1) / 6),
    });
  }
  if (c.difficulty != null) {
    parts.push({ weight: W_DIFFICULTY_INV, value: clamp01(1 - c.difficulty / 100) });
  }
  if (c.maxReachChance != null) {
    const norm =
      c.maxReachChance <= 100
        ? c.maxReachChance / 100
        : Math.min(1, Math.log10(c.maxReachChance + 1) / 7);
    parts.push({ weight: W_REACH, value: clamp01(norm) });
  }
  const bonus = c.cluster != null ? CLUSTER_BONUS[c.cluster.toUpperCase()] ?? 0.4 : 0.4;
  parts.push({ weight: W_CLUSTER_BONUS, value: bonus });

  if (parts.length === 0) return 0;
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const base = parts.reduce((s, p) => s + (p.weight / total) * p.value, 0);
  const languageMultiplier = localeHint
    ? localeLanguageMultiplier(c.keyword, localeHint)
    : 1;
  // Multi-word boost: long-tail keywords (2-4 words) have higher
  // niche-ASO value than single-word generics. A 3-word long-tail
  // beats a 1-word generic at the same popularity. Shared with
  // keywordScore() via the scoring/multipliers module.
  return clamp01(base * languageMultiplier * multiWordBoost(c.keyword));
}

/** Heuristic fallback: derive a default locale code from an Apple
 *  storefront. Used only when the caller didn't pass an explicit
 *  `localeHint` to `proposeSwaps`. Not exhaustive — covers the major
 *  single-language markets where storefront + language are 1:1. */
function territoryToLocale(territory: string): string {
  const t = territory.toUpperCase();
  const map: Record<string, string> = {
    US: "en", GB: "en", AU: "en", CA: "en", NZ: "en", IE: "en",
    CZ: "cs", SK: "sk", PL: "pl", HU: "hu", RO: "ro",
    HR: "hr", BG: "bg", GR: "el", SI: "sl",
    JP: "ja", KR: "ko", CN: "zh", HK: "zh", TW: "zh",
    DE: "de", AT: "de", CH: "de",
    FR: "fr", BE: "fr",
    ES: "es", MX: "es", AR: "es", CL: "es", CO: "es",
    IT: "it", PT: "pt", BR: "pt", NL: "nl",
    TR: "tr", RU: "ru", UA: "uk",
    SE: "sv", NO: "no", DK: "da", FI: "fi",
    SA: "ar", AE: "ar", EG: "ar", IL: "he",
    TH: "th", VN: "vi", ID: "id",
    IN: "hi",
  };
  return map[t] ?? "en";
}


/** Order: DECAY first, then NEUTRAL with low score, then everything
 *  scored < 0.4, then by score ascending. */
function pickWeakCandidates(rows: LocalTrackedKeyword[]): LocalTrackedKeyword[] {
  return [...rows].sort((a, b) => weakRank(a) - weakRank(b));
}

/** Choose which terms to seed Astro's competitor mining with. The
 *  best seeds satisfy ALL of:
 *    • Tracked on Astro's side for this store (else mining 404s)
 *    • popularity ≥ 5 (Astro's documented threshold for mineability)
 *    • Reasonably high popularity (better signal density)
 *
 *  Fall back gracefully when Astro's tracked list is sparse — for new
 *  apps with only a couple of terms, just take whatever's there. The
 *  local CHAMPION list is consulted only as a tertiary fallback. */
function pickAstroMiningSeeds(
  astroTrackedInStore: AstroTrackedKeyword[],
  localTracked: LocalTrackedKeyword[],
  limit: number,
): { keyword: string; popularity: number | null }[] {
  // Primary: Astro-tracked terms with popularity ≥ 5, top by popularity.
  const primary = astroTrackedInStore
    .filter((k) => (k.popularity ?? 0) >= 5 && k.keyword.length > 0)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, limit)
    .map((k) => ({ keyword: k.keyword, popularity: k.popularity ?? null }));

  if (primary.length >= limit) return primary;

  // Secondary: lower-popularity Astro-tracked terms (popularity < 5).
  // Astro may still mine these if they're not pure noise.
  const secondary = astroTrackedInStore
    .filter((k) => !primary.some((p) => p.keyword === k.keyword))
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, limit - primary.length)
    .map((k) => ({ keyword: k.keyword, popularity: k.popularity ?? null }));

  if (primary.length + secondary.length >= limit) {
    return [...primary, ...secondary];
  }

  // Tertiary: fall back to the user's strongest local terms. Astro
  // mining might 404 on these but the attempt is cheap and self-isolating.
  const localSeeds = [...localTracked]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter(
      (k) =>
        !primary.some((p) => p.keyword.toLowerCase() === k.keyword.toLowerCase()) &&
        !secondary.some(
          (s) => s.keyword.toLowerCase() === k.keyword.toLowerCase(),
        ),
    )
    .slice(0, limit - primary.length - secondary.length)
    .map((k) => ({ keyword: k.keyword, popularity: null }));

  return [...primary, ...secondary, ...localSeeds];
}

function weakRank(k: LocalTrackedKeyword): number {
  if (k.bucket === "DECAY") return 0;
  if (k.bucket === "NEUTRAL" && (k.score ?? 1) < 0.3) return 1;
  if ((k.score ?? 1) < 0.4) return 2;
  // Live in field but with a low score is weaker than tracked-only
  // (the user gives up keyword field space for them).
  if (k.inField && (k.score ?? 1) < 0.5) return 3;
  return 4 + (k.score ?? 0); // arbitrary tail, monotonically increasing
}

function renderRationale(
  strong: { candidate: StrongCandidate; score: number },
  weak: LocalTrackedKeyword | null | undefined,
  kind: ProposalKind,
): string {
  const parts: string[] = [];
  const c = strong.candidate;
  if (c.difficulty != null) {
    parts.push(`difficulty ${c.difficulty.toString()} / 100`);
  }
  if (c.maxReachChance != null) {
    parts.push(`max reach chance ${c.maxReachChance.toString()} / 100`);
  }
  if (c.volume != null) {
    parts.push(`volume ${c.volume.toString()}`);
  }
  if (c.popularity != null) {
    parts.push(`Apple popularity ${c.popularity.toFixed(1)}`);
  }
  const sig = parts.length > 0 ? parts.join(" · ") : "candidate from Astro";
  const verdictText =
    kind === "DECAY_AUTO"
      ? `Auto-swap: ${weak?.keyword ?? "(no anchor)"} is DECAY`
      : kind === "OPPORTUNITY_PREVIEW"
        ? `Preview swap: stronger alternative pocket`
        : `New opportunity: app-relevant candidate worth adding`;
  return `${verdictText}. Astro signals: ${sig}.`;
}

async function safeCall<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/** Bridges the optional AiEnricher contract into the StrongCandidate
 *  shape the autopilot scores. Wraps in try/catch so an AI hiccup
 *  never aborts a multi-locale analyze run. */
async function safeAiEnrich(
  enricher: AiEnricher,
  input: AiEnricherInput,
): Promise<StrongCandidate[]> {
  try {
    const out = await enricher(input);
    return out.candidates.map((c) => ({
      keyword: c.keyword,
      popularity: c.popularity ?? null,
      volume: null,
      maxVolume: null,
      difficulty: null,
      maxReachChance: null,
      cluster: c.cluster ?? "LOCALE_AI",
      reason: c.reason ?? null,
      sources: ["astro_suggestion"],
    }));
  } catch {
    return [];
  }
}

/** True when the locale's language is English — we skip AI locale
 *  enrichment for these because Astro's pool already matches. */
function isEnglishLocale(locale: string): boolean {
  const lc = locale.toLowerCase().split(/[-_]/)[0] ?? "";
  return lc === "en";
}

async function safeOptional<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniqueNormalised(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const key = normalise(raw);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out;
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
