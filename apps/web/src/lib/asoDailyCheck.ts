/**
 * ASO daily-check service — server-side composer that turns a
 * (tenantId, appId, date) tuple into everything `runDailyCheck` needs.
 *
 * Steps:
 *   1. Fetch the app + tracked keywords + competitors + recent signals.
 *   2. Build today's vs yesterday's KeywordRankDelta / CompetitorRankDelta /
 *      ConversionDelta / RatingDelta.
 *   3. Call the pure `runDailyCheck` orchestrator with an optional AI
 *      analyst (loaded from the tenant's AI chain).
 *   4. Persist AsoDailyCheck + AsoNotification rows idempotently.
 *
 * The function is intentionally synchronous-from-the-caller's-POV: the
 * route awaits it and returns the AsoDailyCheck row. A future scheduler
 * can call this same function from a BullMQ worker without changes.
 */
import { prisma, Prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import {
  buildAsoAnalystDailyTask,
  runDailyCheck,
  type AlarmEvaluationInput,
  type AnalystCompetitorHighlight,
  type AnalystKeywordHighlight,
  type AnalystMetricSnapshot,
  type AsoAnalystDailyInput,
  type AsoAnalystDailyOutput,
  type CompetitorRankDelta,
  type ConversionDelta,
  type DailyCheckResult,
  type KeywordRankDelta,
} from "@marquee/aso";
import { loadAiOrchestrator } from "@/lib/aiOrchestrator";

export interface RunDailyCheckOptions {
  tenantId: string;
  appId: string;
  /** YYYY-MM-DD. Defaults to today's UTC date. */
  date?: string;
  /** Set `false` to skip the AI analyst (useful for tests / cost
   *  control). Defaults to `true`. */
  withAnalyst?: boolean;
  /** Optional free-text "what changed yesterday" to feed the analyst
   *  for better probable-cause attribution. */
  recentChanges?: string;
  /** Used in AsoDailyCheck.reviewedById when an end-user manually
   *  triggers a re-run. */
  triggeredById?: string | null;
}

export interface DailyCheckPersistResult {
  checkId: string;
  date: string;
  status: "COMPLETED" | "FAILED";
  overallSeverity: DailyCheckResult["overallSeverity"];
  counts: DailyCheckResult["counts"];
  analystReport: AsoAnalystDailyOutput | null;
  notificationsCreated: number;
}

export async function runAndPersistDailyCheck(
  options: RunDailyCheckOptions,
): Promise<DailyCheckPersistResult> {
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  const app = await prisma.app.findFirst({
    where: { id: options.appId, tenantId: options.tenantId },
    include: {
      // The primary locale is identified by App.primaryLocale matching
      // AppLocalization.locale. No `isPrimary` flag on the row itself.
      localizations: { orderBy: { locale: "asc" } },
    },
  });
  if (!app) throw new NotFoundError("App not found");

  // Mark the check as RUNNING — gives the UI something to show
  // while the analyst is being called.
  const existingCheck = await prisma.asoDailyCheck.findUnique({
    where: { appId_date: { appId: options.appId, date: new Date(date) } },
  });
  const runningCheck = await prisma.asoDailyCheck.upsert({
    where: { appId_date: { appId: options.appId, date: new Date(date) } },
    create: {
      tenantId: options.tenantId,
      appId: options.appId,
      date: new Date(date),
      status: "RUNNING",
      reviewedById: options.triggeredById ?? null,
    },
    update: {
      status: "RUNNING",
      reviewedById: options.triggeredById ?? existingCheck?.reviewedById ?? null,
    },
  });

  try {
    const yesterday = subtractDays(date, 1);
    const baseline7d = subtractDays(date, 7);

    // ── Keyword deltas ────────────────────────────────────────────
    const trackedKeywords = await prisma.trackedKeyword.findMany({
      where: { appId: options.appId, status: "ACTIVE" },
    });
    const trackedKeywordIds = trackedKeywords.map((k) => k.id);

    const signals = await prisma.keywordSignal.findMany({
      where: {
        trackedKeywordId: { in: trackedKeywordIds },
        date: { in: [new Date(date), new Date(yesterday)] },
      },
    });
    const signalIdx = new Map<string, Map<string, typeof signals[number]>>();
    for (const s of signals) {
      const key = s.trackedKeywordId;
      const dateKey = s.date.toISOString().slice(0, 10);
      if (!signalIdx.has(key)) signalIdx.set(key, new Map());
      signalIdx.get(key)!.set(dateKey, s);
    }

    const keywordDeltas: KeywordRankDelta[] = trackedKeywords.map((k) => {
      const today = signalIdx.get(k.id)?.get(date) ?? null;
      const prev = signalIdx.get(k.id)?.get(yesterday) ?? null;
      return {
        trackedKeywordId: k.id,
        keyword: k.keyword,
        territory: k.territory,
        rankToday: today?.appStoreRank ?? null,
        rankYesterday: prev?.appStoreRank ?? null,
        bucketToday: today?.bucket ?? null,
        bucketYesterday: prev?.bucket ?? null,
        scoreToday: today?.score != null ? Number(today.score) : null,
        scoreYesterday: prev?.score != null ? Number(prev.score) : null,
        // KeywordSignal stores a single `bucket` (CHAMPION / DECAY /
        // RISING / etc). RISING + FALLING signals from `temporalBucket`
        // are derived on the fly elsewhere — not persisted today.
        temporal: null,
        tags: k.tags.map((t) => t.toLowerCase()),
      };
    });

    // ── Competitor deltas ─────────────────────────────────────────
    const competitors = await prisma.competitor.findMany({
      where: { appId: options.appId, monitor: true },
    });
    const competitorIds = competitors.map((c) => c.id);

    const competitorRanks = await prisma.competitorRank.findMany({
      where: {
        competitorId: { in: competitorIds },
        date: { in: [new Date(date), new Date(yesterday)] },
      },
      include: { trackedKeyword: { select: { id: true, keyword: true } } },
    });
    const competitorDeltas: CompetitorRankDelta[] = [];
    const compIdx = new Map<string, { today?: typeof competitorRanks[number]; prev?: typeof competitorRanks[number] }>();
    for (const r of competitorRanks) {
      const key = `${r.competitorId}|${r.trackedKeywordId}`;
      const slot = compIdx.get(key) ?? {};
      if (r.date.toISOString().slice(0, 10) === date) slot.today = r;
      else slot.prev = r;
      compIdx.set(key, slot);
    }

    // Our rank "today" — index the per-keyword signal by id for the
    // overtook-us check inside `evaluateCompetitorIntrusion`.
    const ourRankByKw = new Map<string, number | null>();
    for (const k of trackedKeywords) {
      ourRankByKw.set(k.id, signalIdx.get(k.id)?.get(date)?.appStoreRank ?? null);
    }
    for (const [key, slot] of compIdx.entries()) {
      const [competitorId, trackedKeywordId] = key.split("|");
      if (!competitorId || !trackedKeywordId) continue;
      const competitor = competitors.find((c) => c.id === competitorId);
      const r = slot.today ?? slot.prev;
      if (!competitor || !r) continue;
      competitorDeltas.push({
        competitorId,
        competitorName: competitor.appName,
        trackedKeywordId,
        keyword: r.trackedKeyword.keyword,
        rankToday: slot.today?.rank ?? null,
        rankYesterday: slot.prev?.rank ?? null,
        ourRankToday: ourRankByKw.get(trackedKeywordId) ?? null,
      });
    }

    // ── Conversion + rating deltas ────────────────────────────────
    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: {
        appId: options.appId,
        date: { gte: new Date(baseline7d), lte: new Date(date) },
      },
      orderBy: { date: "desc" },
    });
    const snapToday = snapshots.find((s) => s.date.toISOString().slice(0, 10) === date);
    const snapYesterday = snapshots.find((s) => s.date.toISOString().slice(0, 10) === yesterday);
    const baseline = snapshots.filter((s) => s.date.toISOString().slice(0, 10) !== date);

    // AnalyticsSnapshot stores conversion as `pvcrPct` (page-view CR %)
    // and lacks rating/review counts — we surface nulls there so the
    // engine simply skips those evaluators until the rating ingestion
    // pipeline is wired up.
    const conversion: ConversionDelta | undefined =
      snapToday && baseline.length > 0
        ? {
            cvrToday: snapToday.pvcrPct != null ? Number(snapToday.pvcrPct) : null,
            cvrBaseline: avg(
              baseline.map((s) => (s.pvcrPct != null ? Number(s.pvcrPct) : null)),
            ),
            impressionsToday: snapToday.impressions,
            impressionsBaseline: Math.round(
              avg(baseline.map((s) => s.impressions)) ?? 0,
            ),
            downloadsToday: snapToday.downloads,
            downloadsBaseline: Math.round(avg(baseline.map((s) => s.downloads)) ?? 0),
          }
        : undefined;

    // Rating ingestion not wired yet — leave undefined so the engine
    // skips the rating + review-sentiment evaluators cleanly.
    const rating = undefined;

    // ── Orchestrate ───────────────────────────────────────────────
    const alarmInput: AlarmEvaluationInput = {
      keywordDeltas,
      competitorDeltas,
      conversion,
      rating,
    };

    const analystBase: Omit<AsoAnalystDailyInput, "alarms"> = {
      appName: app.appName,
      bundleId: app.bundleId,
      platform: app.platform,
      primaryLocale: app.primaryLocale,
      // App row carries no genre — Astro / store-metadata sources do.
      // Leave null until that's wired through.
      primaryGenre: null,
      metrics: buildAnalystMetrics(date, snapToday, snapYesterday, baseline),
      keywordHighlights: pickKeywordHighlights(keywordDeltas),
      competitorHighlights: pickCompetitorHighlights(competitorDeltas),
      recentChanges: options.recentChanges ?? null,
    };

    let runAnalyst: ((input: AsoAnalystDailyInput) => Promise<AsoAnalystDailyOutput | null>) | undefined;
    if (options.withAnalyst !== false) {
      try {
        const { orchestrator } = await loadAiOrchestrator(options.tenantId);
        runAnalyst = async (analystInput) => {
          const task = buildAsoAnalystDailyTask(analystInput);
          const result = await orchestrator.run(task);
          return result.ok ? result.output : null;
        };
      } catch {
        // AI not configured for this tenant — skip silently and run
        // with engine-only output. The notification rows still get
        // written; just no consultant interpretation column.
        runAnalyst = undefined;
      }
    }

    const result = await runDailyCheck({
      appId: options.appId,
      date,
      alarmInput,
      analystInputBase: analystBase,
      runAnalyst,
    });

    // ── Persist ───────────────────────────────────────────────────
    const created = await prisma.$transaction(async (tx) => {
      // Idempotent notification upserts keyed by dedupKey.
      let createdCount = 0;
      for (const n of result.notifications) {
        try {
          await tx.asoNotification.upsert({
            where: { dedupKey: n.dedupKey },
            create: {
              tenantId: options.tenantId,
              appId: options.appId,
              date: new Date(date),
              dedupKey: n.dedupKey,
              severity: n.severity,
              title: n.title,
              message: n.message,
              payload: n.payload as object,
              trackedKeywordId: n.trackedKeywordId,
              competitorId: n.competitorId,
              agentInterpretation: n.agentInterpretation,
              agentProbableCause: n.agentProbableCause,
              agentNextAction: n.agentNextAction,
              agentConfidence: n.agentConfidence,
            },
            update: {
              // Update analyst fields only — keep the read state so a
              // re-run doesn't un-read what the user already saw.
              agentInterpretation: n.agentInterpretation,
              agentProbableCause: n.agentProbableCause,
              agentNextAction: n.agentNextAction,
              agentConfidence: n.agentConfidence,
            },
          });
          createdCount += 1;
        } catch {
          // Unique-conflict race or schema drift — keep going so the
          // other notifications still persist.
        }
      }

      // alarmsTriggered is String[] — store the kinds for quick UI
      // chips; the full event JSON lives in asoNotification rows.
      const alarmKinds = Array.from(new Set(result.events.map((e) => e.kind)));

      const updated = await tx.asoDailyCheck.update({
        where: { id: runningCheck.id },
        data: {
          status: "COMPLETED",
          metricsSnapshot: snapToday
            ? (jsonSafe(snapToday) as object)
            : ({} as object),
          keywordDeltas: jsonSafe(keywordDeltas) as object,
          competitorMoves: jsonSafe(competitorDeltas) as object,
          alarmsTriggered: alarmKinds,
          analystReport: result.analystReport
            ? (jsonSafe(result.analystReport) as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
      return { check: updated, createdCount };
    });

    return {
      checkId: created.check.id,
      date,
      status: "COMPLETED",
      overallSeverity: result.overallSeverity,
      counts: result.counts,
      analystReport: result.analystReport,
      notificationsCreated: created.createdCount,
    };
  } catch (err) {
    await prisma.asoDailyCheck.update({
      where: { id: runningCheck.id },
      data: {
        status: "FAILED",
        analystReport: {
          error: err instanceof Error ? err.message : String(err),
        } as object,
      },
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function subtractDays(yyyyMmDd: string, days: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function avg(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v != null);
  if (real.length === 0) return null;
  return real.reduce((a, b) => a + b, 0) / real.length;
}

function buildAnalystMetrics(
  date: string,
  today: { pvcrPct: unknown; impressions: number; downloads: number } | undefined,
  yesterday: { pvcrPct: unknown; impressions: number; downloads: number } | undefined,
  baseline: { pvcrPct: unknown; impressions: number; downloads: number }[],
): AnalystMetricSnapshot {
  return {
    date,
    downloadsToday: today?.downloads ?? null,
    downloadsYesterday: yesterday?.downloads ?? null,
    downloads7dAvg: avg(baseline.map((s) => s.downloads)),
    impressionsToday: today?.impressions ?? null,
    impressionsYesterday: yesterday?.impressions ?? null,
    cvrToday: today?.pvcrPct != null ? Number(today.pvcrPct) : null,
    cvrYesterday: yesterday?.pvcrPct != null ? Number(yesterday.pvcrPct) : null,
    cvr7dAvg: avg(baseline.map((s) => (s.pvcrPct != null ? Number(s.pvcrPct) : null))),
    // Rating ingestion not yet wired — daily check skips rating
    // alarms while these stay null. UI calls out the gap.
    ratingToday: null,
    ratingYesterday: null,
    newLowStarReviewsToday: 0,
  };
}

function pickKeywordHighlights(deltas: KeywordRankDelta[]): AnalystKeywordHighlight[] {
  // Surface the most-material moves first — sort by absolute delta.
  return deltas
    .filter((d) => d.rankToday != null || d.rankYesterday != null)
    .map((d) => ({
      delta: Math.abs((d.rankYesterday ?? 100) - (d.rankToday ?? 100)),
      payload: d,
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20)
    .map(({ payload }) => ({
      trackedKeywordId: payload.trackedKeywordId,
      keyword: payload.keyword,
      territory: payload.territory,
      tags: payload.tags,
      rankToday: payload.rankToday,
      rankYesterday: payload.rankYesterday,
      bucketToday: payload.bucketToday,
    }));
}

function pickCompetitorHighlights(deltas: CompetitorRankDelta[]): AnalystCompetitorHighlight[] {
  return deltas
    .filter((d) => d.rankToday != null || d.rankYesterday != null)
    .slice(0, 10)
    .map((d) => ({
      competitorId: d.competitorId,
      competitorName: d.competitorName,
      keyword: d.keyword,
      rankToday: d.rankToday,
      rankYesterday: d.rankYesterday,
      ourRankToday: d.ourRankToday,
    }));
}

/** Strip Date / Decimal / undefined so the value is JSON-storable. */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
