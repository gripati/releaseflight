/**
 * GET /api/v1/apps/[id]/aso/movers?window=7
 *
 * Ranks every ACTIVE tracked keyword by the score delta over the last
 * `window` days. Returns the top 8 gainers + top 8 losers — the "ticker
 * tape" / mover chips at the top of the Trading Floor overview.
 *
 * Each item carries:
 *   - keyword + territory + current bucket
 *   - latestScore + previousScore + delta
 *   - latestRank (App Store position, 1..50 or null)
 *   - latestTrendsScore (Google Trends 0..100)
 *   - sparkline data (last N daily score points, oldest first)
 */
import { NextResponse, type NextRequest } from "next/server";
import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const windowDays = clamp(Number(url.searchParams.get("window") ?? "7"), 2, 60);
  const sparkLen = clamp(Number(url.searchParams.get("spark") ?? "14"), 7, 30);

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - Math.max(windowDays, sparkLen));

    const keywords = await prisma.trackedKeyword.findMany({
      where: { appId: id, status: "ACTIVE" },
      include: {
        signals: {
          where: { date: { gte: since } },
          orderBy: { date: "asc" },
        },
      },
    });

    const items = keywords
      .filter((k) => k.signals.length >= 2)
      .map((k) => {
        const signals = k.signals;
        const latest = signals[signals.length - 1]!;
        // Pick the signal that is `windowDays` old (or the oldest available)
        const pivot = pickPivot(signals, windowDays);
        const latestScore = numOr(latest.score, 0);
        const prevScore = numOr(pivot.score, 0);
        const delta = latestScore - prevScore;
        const deltaPct = prevScore > 0 ? (delta / prevScore) * 100 : null;
        return {
          id: k.id,
          keyword: k.keyword,
          territory: k.territory,
          source: k.source,
          bucket: latest.bucket,
          latestScore,
          previousScore: prevScore,
          delta,
          deltaPct,
          latestRank: latest.appStoreRank,
          previousRank: pivot.appStoreRank,
          latestVolume: latest.volume,
          latestDifficulty: latest.difficulty,
          spark: signals.slice(-sparkLen).map((s) => ({
            date: s.date.toISOString().slice(0, 10),
            score: numOr(s.score, 0),
            rank: s.appStoreRank,
          })),
        };
      });

    const gainers = [...items]
      .filter((i) => i.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8);
    const losers = [...items]
      .filter((i) => i.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 8);
    const flat = [...items]
      .filter((i) => i.delta === 0)
      .sort((a, b) => b.latestScore - a.latestScore)
      .slice(0, 5);

    return NextResponse.json({
      windowDays,
      sparkLen,
      counts: {
        gainers: gainers.length,
        losers: losers.length,
        flat: flat.length,
        total: items.length,
      },
      gainers,
      losers,
      flat,
    });
  });
});

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function numOr(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

interface SignalRow {
  date: Date;
  score: Decimal | null;
  appStoreRank: number | null;
  volume: number | null;
  difficulty: number | null;
  bucket: string | null;
}

function pickPivot(signals: SignalRow[], daysAgo: number): SignalRow {
  // Return the signal closest to (today - daysAgo). signals are
  // sorted ascending by date.
  const target = new Date();
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() - daysAgo);
  const targetMs = target.getTime();
  let best = signals[0]!;
  let bestDiff = Math.abs(best.date.getTime() - targetMs);
  for (const s of signals) {
    const d = Math.abs(s.date.getTime() - targetMs);
    if (d < bestDiff) {
      best = s;
      bestDiff = d;
    }
  }
  return best;
}
