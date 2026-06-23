/**
 * GET /api/v1/apps/[id]/aso/keywords/[kwId]/detail
 *
 * Full per-keyword research dossier. Used by the KeywordDetailPopover
 * so a non-ASO user can read exactly what was analysed and why the
 * system reached its conclusion.
 *
 * Returns:
 *   • The latest KeywordSignal row (all 14 fields)
 *   • A 90-day history of signals so the UI can chart trends
 *   • The composite-score breakdown — every component, its weight,
 *     and its contribution to the final number
 *   • Bucket reasoning in plain English
 *   • Recommendation: keep / swap / target slot
 *   • Data sources that fed each signal (Apple Search Ads / Trends /
 *     iTunes Search / Astro MCP / Apple Search Hints)
 *
 * Everything here is read-only; no AI calls. Cheap to render.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string; kwId: string }>;
}

/** Map of accepted range tokens to day windows. `1d` means today
 *  only — useful when the caller just wants the latest signal without
 *  any history. Everything else fetches that many days backward from
 *  today (inclusive). */
const RANGE_DAYS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
  "180d": 180,
};

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id, kwId } = await context.params;

  // Range param defaults to 90d (UI gets a full quarter of history by
  // default). Unknown tokens fall back to 90d to stay backwards
  // compatible with older callers.
  const url = new URL(req.url);
  const rangeToken = url.searchParams.get("range") ?? "90d";
  const days = RANGE_DAYS[rangeToken] ?? RANGE_DAYS["90d"]!;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  return withTenantContext(async () => {
    const keyword = await prisma.trackedKeyword.findUnique({
      where: { id: kwId },
      include: {
        signals: {
          where: { date: { gte: since } },
          orderBy: { date: "desc" },
          take: days,
        },
      },
    });
    if (keyword?.appId !== id) throw new NotFoundError("Keyword not found");

    const latest = keyword.signals[0] ?? null;

    // Compute the score breakdown — same formula keywordScore uses,
    // but here we surface each component so the UI can render the
    // "where does this 0.43 come from?" panel.
    const breakdown = buildScoreBreakdown(latest);

    // Plain-English analysis the UI shows at the top of the popover.
    const analysis = buildAnalysis(keyword, latest);

    // Suggested replacements — for any keyword scored DECAY / NEUTRAL,
    // find the top-N tracked candidates in the SAME storefront that
    // outscore this one. Lets the UI render a "Swap with X" panel that
    // the user can act on without leaving the popover.
    let suggestedReplacements: SuggestedReplacement[] = [];
    if (analysis.recommendedAction === "SWAP" || analysis.recommendedAction === "WATCH") {
      const myScore = latest?.score != null ? Number(latest.score) : null;
      const candidates = await prisma.trackedKeyword.findMany({
        where: {
          appId: id,
          territory: keyword.territory,
          status: "ACTIVE",
          id: { not: keyword.id },
        },
        include: { signals: { orderBy: { date: "desc" }, take: 1 } },
        take: 200,
      });
      const ranked = candidates
        .map((c) => {
          const sig = c.signals[0];
          return {
            id: c.id,
            keyword: c.keyword,
            score: sig?.score != null ? Number(sig.score) : null,
            bucket: sig?.bucket ?? null,
            rank: sig?.appStoreRank ?? null,
          };
        })
        .filter((c) => {
          const b = c.bucket;
          if (b === "CHAMPION" || b === "OPPORTUNITY" || b === "RISING") return true;
          // Untracked strength → only allow if score beats ours
          return myScore != null && c.score != null && c.score > myScore + 0.1;
        })
        .sort((a, b) => {
          const ra = bucketRank(a.bucket);
          const rb = bucketRank(b.bucket);
          if (ra !== rb) return rb - ra;
          return (b.score ?? 0) - (a.score ?? 0);
        })
        .slice(0, 5);
      suggestedReplacements = ranked;
    }

    return NextResponse.json({
      keyword: {
        id: keyword.id,
        text: keyword.keyword,
        territory: keyword.territory,
        source: keyword.source,
        status: keyword.status,
        notes: keyword.notes,
        createdAt: keyword.createdAt.toISOString(),
      },
      latest: latest
        ? {
            date: latest.date.toISOString().slice(0, 10),
            score: latest.score != null ? Number(latest.score) : null,
            bucket: latest.bucket,
            appStoreRank: latest.appStoreRank,
            volume: latest.volume,
            maxVolume: latest.maxVolume,
            difficulty: latest.difficulty,
            maxReachChance: latest.maxReachChance,
          }
        : null,
      history: keyword.signals
        .slice()
        .reverse()
        .map((s) => ({
          date: s.date.toISOString().slice(0, 10),
          score: s.score != null ? Number(s.score) : null,
          bucket: s.bucket,
          appStoreRank: s.appStoreRank,
          volume: s.volume,
          difficulty: s.difficulty,
        })),
      breakdown,
      analysis,
      suggestedReplacements,
    });
  });
});

interface SuggestedReplacement {
  id: string;
  keyword: string;
  score: number | null;
  bucket: string | null;
  rank: number | null;
}

function bucketRank(b: string | null): number {
  if (b === "CHAMPION") return 100;
  if (b === "OPPORTUNITY") return 80;
  if (b === "RISING") return 60;
  if (b === "NEUTRAL") return 20;
  if (b === "DECAY") return 0;
  return 10;
}

interface ScoreComponent {
  name: string;
  label: string;
  /** Plain-English description of where this value comes from. */
  source: string;
  /** Raw value pulled from the signal. */
  rawValue: number | null;
  /** Same value normalised to 0-1, what the score formula consumed. */
  normalised: number | null;
  /** This component's weight in the formula (0-1). */
  weight: number;
  /** weight × normalised = contribution to the final score. */
  contribution: number | null;
  /** True when this component is missing and re-normalisation kicks in. */
  missing: boolean;
}

interface ScoreBreakdown {
  finalScore: number | null;
  bucket: string | null;
  components: ScoreComponent[];
  /** Sum of weights for the components that WERE present (≤ 1.0). */
  effectiveWeight: number;
  /** Why we landed in this bucket, in one sentence. */
  bucketReason: string;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

interface LatestRow {
  appStoreRank: number | null;
  volume: number | null;
  maxVolume: number | null;
  difficulty: number | null;
  maxReachChance: number | null;
  score: { toString(): string } | number | null;
  bucket: string | null;
}

function buildScoreBreakdown(latest: LatestRow | null): ScoreBreakdown {
  if (!latest) {
    return {
      finalScore: null,
      bucket: null,
      components: [],
      effectiveWeight: 0,
      bucketReason: "No data — run Astro Autopilot to populate signals.",
    };
  }

  // Mirrors packages/aso/src/scoring/keywordScore.ts (Astro-only)
  // weights so the UI explanation matches the actual score. If you
  // update one, update both.
  const components: ScoreComponent[] = [
    {
      name: "volumeShare",
      label: "Astro popularity",
      source: "Astro's 0-100 search popularity — Apple's real search index for this storefront.",
      rawValue: latest.volume,
      normalised:
        latest.volume != null && latest.maxVolume != null && latest.maxVolume > 0
          ? clamp01(latest.volume / latest.maxVolume)
          : latest.volume != null
            ? clamp01(latest.volume / 100)
            : null,
      weight: 0.4,
      contribution:
        latest.volume != null && latest.maxVolume != null && latest.maxVolume > 0
          ? 0.4 * clamp01(latest.volume / latest.maxVolume)
          : latest.volume != null
            ? 0.4 * clamp01(latest.volume / 100)
            : null,
      missing: latest.volume == null,
    },
    {
      name: "difficulty",
      label: "Astro difficulty (inverted)",
      source:
        "Astro's 0-100 keyword difficulty — inverted, so easier-to-rank keywords score higher.",
      rawValue: latest.difficulty,
      normalised: latest.difficulty != null ? clamp01(1 - latest.difficulty / 100) : null,
      weight: 0.25,
      contribution: latest.difficulty != null ? 0.25 * clamp01(1 - latest.difficulty / 100) : null,
      missing: latest.difficulty == null,
    },
    {
      name: "maxReachChance",
      label: "Astro max reach chance",
      source: "Astro's estimate of peak reach if your app ranked #1.",
      rawValue: latest.maxReachChance,
      normalised:
        latest.maxReachChance != null
          ? clamp01(
              latest.maxReachChance <= 100
                ? latest.maxReachChance / 100
                : Math.min(1, Math.log10(latest.maxReachChance + 1) / 7),
            )
          : null,
      weight: 0.15,
      contribution:
        latest.maxReachChance != null
          ? 0.15 *
            clamp01(
              latest.maxReachChance <= 100
                ? latest.maxReachChance / 100
                : Math.min(1, Math.log10(latest.maxReachChance + 1) / 7),
            )
          : null,
      missing: latest.maxReachChance == null,
    },
    {
      name: "appStoreRank",
      label: "App Store rank (inverted)",
      source:
        "Your app's live position in App Store search (1 = top, null = beyond top 50). Pulled from Astro's search_rankings.",
      rawValue: latest.appStoreRank,
      normalised: latest.appStoreRank != null ? 1 / Math.max(latest.appStoreRank, 1) : null,
      weight: 0.2,
      contribution:
        latest.appStoreRank != null ? 0.2 * (1 / Math.max(latest.appStoreRank, 1)) : null,
      missing: latest.appStoreRank == null,
    },
  ];

  const effectiveWeight = components.filter((c) => !c.missing).reduce((s, c) => s + c.weight, 0);
  const score = latest.score != null ? Number(latest.score) : null;

  return {
    finalScore: score,
    bucket: latest.bucket,
    components,
    effectiveWeight,
    bucketReason: explainBucket(latest, score),
  };
}

function explainBucket(latest: LatestRow, score: number | null): string {
  const bucket = latest.bucket;
  if (!bucket) return "No bucket assigned — wait for the next sync.";
  if (bucket === "CHAMPION") {
    return `Score ${score?.toFixed(2) ?? "—"} ≥ 0.75 — strong demand signals across the board, this is a keeper.`;
  }
  if (bucket === "OPPORTUNITY") {
    return `Score ${score?.toFixed(2) ?? "—"} between 0.40-0.75 — meaningful demand and your app isn't capturing the upside yet.`;
  }
  if (bucket === "RISING") {
    return `Score moving up over the last 7 days — historical signal flagged this keyword as trending.`;
  }
  if (bucket === "DECAY") {
    return `App Store rank dropped out of top 50 AND score < 0.20 — this keyword is no longer pulling weight, consider swapping.`;
  }
  return `Score ${score?.toFixed(2) ?? "—"} — neutral signal, neither strong nor weak. Keep watching.`;
}

interface KeywordRow {
  keyword: string;
  territory: string;
  status: string;
}

interface AnalysisOutput {
  headline: string;
  signalSummary: string;
  recommendedAction: "KEEP" | "PROMOTE" | "SWAP" | "WATCH" | "GATHER_DATA";
  recommendedSlot: "TITLE" | "SUBTITLE" | "KEYWORDS" | "PROMO" | "WATCHLIST" | "REMOVE";
  reasoning: string[];
}

function buildAnalysis(keyword: KeywordRow, latest: LatestRow | null): AnalysisOutput {
  const reasoning: string[] = [];
  const kwText = keyword.keyword;
  const cc = keyword.territory;

  if (!latest) {
    return {
      headline: `"${kwText}" hasn't been scored yet`,
      signalSummary: `Tracked for the ${cc} storefront but no Astro signals have come in. Run Astro Autopilot on the metadata workbench to populate popularity, difficulty, rank, and max reach chance for this keyword.`,
      recommendedAction: "GATHER_DATA",
      recommendedSlot: "WATCHLIST",
      reasoning: ["No KeywordSignal row exists yet for this keyword."],
    };
  }

  const score = latest.score != null ? Number(latest.score) : null;
  const bucket = latest.bucket;
  const rank = latest.appStoreRank;
  const volume = latest.volume;
  const difficulty = latest.difficulty;
  const maxReachChance = latest.maxReachChance;

  // Build sentence-by-sentence reasoning so even a non-ASO reader can
  // walk through the logic.
  const sigParts: string[] = [];
  if (volume != null) {
    sigParts.push(`Astro popularity ${volume.toString()}/100 in ${cc}`);
  }
  if (difficulty != null) {
    sigParts.push(
      `difficulty ${difficulty.toString()}/100 (${difficulty < 30 ? "easy" : difficulty < 60 ? "moderate" : "hard"} to rank)`,
    );
  }
  if (maxReachChance != null) {
    sigParts.push(`max reach chance ${maxReachChance.toString()}`);
  }
  if (rank != null) {
    sigParts.push(`your app currently ranks #${rank.toString()}`);
  } else {
    sigParts.push(`your app is outside the top 50 results`);
  }
  const signalSummary =
    sigParts.length === 0
      ? "No Astro signal data has been collected yet."
      : `For "${kwText}" in ${cc}: ${sigParts.join(" · ")}.`;

  // Reasoning steps
  if (volume != null) {
    if (volume >= 70)
      reasoning.push(
        `Astro flags this term as high-popularity (${volume.toString()}/100) — real users actively search for it.`,
      );
    else if (volume >= 30)
      reasoning.push(
        `Moderate Astro popularity (${volume.toString()}/100) — meaningful demand, not viral.`,
      );
    else reasoning.push(`Low Astro popularity (${volume.toString()}/100) — niche demand in ${cc}.`);
  }
  if (difficulty != null) {
    if (difficulty < 30)
      reasoning.push(
        `Difficulty ${difficulty.toString()}/100 is low — winnable even without authority.`,
      );
    else if (difficulty < 60)
      reasoning.push(
        `Difficulty ${difficulty.toString()}/100 is moderate — possible with good metadata + a few months.`,
      );
    else
      reasoning.push(
        `Difficulty ${difficulty.toString()}/100 is high — only worth chasing if relevance is exceptional.`,
      );
  }
  if (rank != null && rank <= 10)
    reasoning.push(
      `Already ranking in the top ${rank.toString()} — preserve this position, don't gamble with the slot.`,
    );
  else if (rank != null && rank <= 30)
    reasoning.push(
      `Currently #${rank.toString()} — within striking distance of top 10 with stronger metadata.`,
    );
  else if (rank == null)
    reasoning.push(
      `Your app is outside the top 50 — either you're not targeting this keyword in metadata or the term is wrong-intent.`,
    );

  // Decision logic
  let recommendedAction: AnalysisOutput["recommendedAction"];
  let recommendedSlot: AnalysisOutput["recommendedSlot"];
  let headline: string;

  if (bucket === "CHAMPION") {
    recommendedAction = "KEEP";
    recommendedSlot = rank != null && rank <= 10 ? "TITLE" : "SUBTITLE";
    headline = `"${kwText}" is a champion — keep investing`;
    reasoning.push(
      `Verdict: this keyword scores ${score?.toFixed(2) ?? "—"} in the top bucket. Lock it into a high-weight slot and protect the position.`,
    );
  } else if (bucket === "OPPORTUNITY") {
    recommendedAction = "PROMOTE";
    recommendedSlot = "SUBTITLE";
    headline = `"${kwText}" is an opportunity — promote it to a stronger slot`;
    reasoning.push(
      `Verdict: meaningful demand + you're not yet capturing the upside. Move it into subtitle or front of keywords field.`,
    );
  } else if (bucket === "RISING") {
    recommendedAction = "PROMOTE";
    recommendedSlot = "KEYWORDS";
    headline = `"${kwText}" is rising — ride the trend`;
    reasoning.push(
      `Verdict: signals are moving up week-over-week. Add it to the keywords field while difficulty is still low.`,
    );
  } else if (bucket === "DECAY") {
    recommendedAction = "SWAP";
    recommendedSlot = "REMOVE";
    headline = `"${kwText}" is decaying — swap it out`;
    reasoning.push(
      `Verdict: rank dropped + score sub-0.2 → this keyword is dead weight. Replace with a stronger long-tail or painkiller term.`,
    );
  } else {
    // NEUTRAL or no bucket
    recommendedAction = "WATCH";
    recommendedSlot = "WATCHLIST";
    headline = `"${kwText}" is neutral — keep monitoring`;
    reasoning.push(
      `Verdict: no strong signal either way. Keep it on the watchlist; revisit after the next two sync cycles.`,
    );
  }

  return {
    headline,
    signalSummary,
    recommendedAction,
    recommendedSlot,
    reasoning,
  };
}
