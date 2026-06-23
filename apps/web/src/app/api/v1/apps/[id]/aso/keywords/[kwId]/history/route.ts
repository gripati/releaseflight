/**
 * GET /api/v1/apps/[id]/aso/keywords/[kwId]/history?range=30d
 *
 * Full per-day signal history for one tracked keyword + cross-referenced
 * MetadataSnapshot push events that fell inside the window. The UI uses
 * this to draw the "stock chart" for one keyword and to overlay
 * vertical annotation lines at every metadata push so the user can
 * read "rank improved 8 → 3 the day we shipped Spanish localization".
 *
 * Co-fetches: nearby keywords (same app) sharing tokens with this one —
 * a cheap "alternatives" hint the UI shows alongside, without invoking
 * the AI. (AI suggestions live on /aso/keywords/suggest.)
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string; kwId: string }>;
}

const RANGE_TO_DAYS: Record<string, number> = { "14d": 14, "30d": 30, "90d": 90, "180d": 180 };

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id, kwId } = await context.params;
  const url = new URL(req.url);
  const range = (url.searchParams.get("range") ?? "30d") in RANGE_TO_DAYS
    ? (url.searchParams.get("range") ?? "30d")
    : "30d";
  const days = RANGE_TO_DAYS[range]!;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const keyword = await prisma.trackedKeyword.findFirst({
      where: { id: kwId, appId: id },
    });
    if (!keyword) throw new NotFoundError("Tracked keyword not found");

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days);

    const [signals, snapshots, neighbours, downloads] = await Promise.all([
      prisma.keywordSignal.findMany({
        where: { trackedKeywordId: kwId, date: { gte: since } },
        orderBy: { date: "asc" },
      }),
      prisma.metadataSnapshot.findMany({
        where: { appId: id, pushedAt: { gte: since } },
        orderBy: { pushedAt: "asc" },
        select: {
          id: true,
          locale: true,
          pushedAt: true,
          name: true,
          subtitle: true,
          keywordsField: true,
        },
      }),
      prisma.trackedKeyword.findMany({
        where: {
          appId: id,
          id: { not: kwId },
          territory: keyword.territory,
          status: "ACTIVE",
        },
        include: { signals: { orderBy: { date: "desc" }, take: 1 } },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { appId: id, date: { gte: since } },
        orderBy: { date: "asc" },
        select: { date: true, downloads: true, pageViews: true, pvcrPct: true },
      }),
    ]);

    // Surface push events that mentioned the keyword in the keywordsField
    // (iOS) — these are the "shipped this in metadata" moments.
    const pushesTouchingKeyword = snapshots.filter((s) =>
      (s.keywordsField ?? "").toLowerCase().includes(keyword.keyword.toLowerCase()),
    );

    // Cheap neighbour-keyword suggestion: same territory, share a token.
    const tokens = tokenise(keyword.keyword);
    const alternatives = neighbours
      .map((n) => {
        const sig = n.signals[0];
        return {
          id: n.id,
          keyword: n.keyword,
          territory: n.territory,
          score: sig?.score !== null && sig?.score !== undefined ? Number(sig.score) : null,
          bucket: sig?.bucket ?? null,
          rank: sig?.appStoreRank ?? null,
          overlap: tokenOverlap(tokens, tokenise(n.keyword)),
        };
      })
      .filter((a) => a.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8);

    return NextResponse.json({
      keyword: {
        id: keyword.id,
        keyword: keyword.keyword,
        territory: keyword.territory,
        source: keyword.source,
        status: keyword.status,
        notes: keyword.notes,
        createdAt: keyword.createdAt.toISOString(),
      },
      range,
      windowDays: days,
      signals: signals.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        appStoreRank: s.appStoreRank,
        volume: s.volume,
        maxVolume: s.maxVolume,
        difficulty: s.difficulty,
        maxReachChance: s.maxReachChance,
        score: s.score !== null ? Number(s.score) : null,
        bucket: s.bucket,
      })),
      downloads: downloads.map((d) => ({
        date: d.date.toISOString().slice(0, 10),
        downloads: d.downloads,
        pageViews: d.pageViews,
        pvcrPct: Number(d.pvcrPct),
      })),
      pushAnnotations: pushesTouchingKeyword.map((s) => ({
        id: s.id,
        locale: s.locale,
        pushedAt: s.pushedAt.toISOString(),
        keywordsField: s.keywordsField,
        name: s.name,
        subtitle: s.subtitle,
      })),
      alternatives,
    });
  });
});

function tokenise(keyword: string): Set<string> {
  return new Set(
    keyword
      .toLowerCase()
      .split(/[\s,/]+/)
      .map((t) => t.replace(/[^\w]/g, ""))
      .filter((t) => t.length >= 3),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}
