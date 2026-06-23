/**
 * GET /api/v1/apps/[id]/aso/overview
 *
 * Editorial KPI cards on the ASO landing page:
 *   - Last 30d totals (impressions / pageViews / downloads / PVCR)
 *   - Sparkline points (daily PVCR for the same window)
 *   - Latest sync timestamp
 *   - Tracked-keyword counts by status
 *
 * Read-only. No body. Heavy reads are kept thin — the full daily series
 * lives behind /aso/analytics.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, appName: true, platform: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - WINDOW_DAYS);

    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: { appId: id, date: { gte: since } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        impressions: true,
        pageViews: true,
        downloads: true,
        firstTimeDownloads: true,
        pvcrPct: true,
      },
    });

    const totals = snapshots.reduce(
      (acc, s) => ({
        impressions: acc.impressions + s.impressions,
        pageViews: acc.pageViews + s.pageViews,
        downloads: acc.downloads + s.downloads,
        firstTimeDownloads: acc.firstTimeDownloads + s.firstTimeDownloads,
      }),
      { impressions: 0, pageViews: 0, downloads: 0, firstTimeDownloads: 0 },
    );
    const pvcrPct = totals.pageViews > 0
      ? Number(((totals.downloads / totals.pageViews) * 100).toFixed(2))
      : 0;

    const keywordCounts = await prisma.trackedKeyword.groupBy({
      by: ["status"],
      where: { appId: id },
      _count: { _all: true },
    });
    const keywordsByStatus: Record<string, number> = {
      ACTIVE: 0,
      PAUSED: 0,
      ARCHIVED: 0,
    };
    for (const row of keywordCounts) {
      keywordsByStatus[row.status] = row._count._all;
    }

    const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    return NextResponse.json({
      app: { id: app.id, appName: app.appName, platform: app.platform },
      windowDays: WINDOW_DAYS,
      totals: { ...totals, pvcrPct },
      sparkline: snapshots.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        pvcrPct: Number(s.pvcrPct),
        downloads: s.downloads,
      })),
      keywordsByStatus,
      lastSyncAt: lastSnapshot?.date.toISOString() ?? null,
    });
  });
});
