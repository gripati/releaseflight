/**
 * GET /api/v1/apps/[id]/aso/analytics?range=30d&territory=ALL
 *
 * Full daily roll-up + funnel breakdown for the ASO → Analytics page.
 * - range: 7d | 30d | 90d (default 30d)
 * - territory: ISO 3166-1 alpha-2 OR "ALL" (default ALL)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { detectFunnelAnomalies, type FunnelDiagnostic } from "@marquee/aso";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RangeQuery = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  territory: z.string().regex(/^([A-Z]{2}|ALL)$/).default("ALL"),
});

const RANGE_TO_DAYS: Record<"7d" | "30d" | "90d", number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const { range, territory } = RangeQuery.parse({
    range: url.searchParams.get("range") ?? undefined,
    territory: url.searchParams.get("territory") ?? undefined,
  });

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, appName: true, platform: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const days = RANGE_TO_DAYS[range];
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days);

    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: { appId: id, date: { gte: since } },
      orderBy: { date: "asc" },
    });

    const funnels = await prisma.analyticsFunnel.findMany({
      where: { appId: id, date: { gte: since }, territory },
      orderBy: { date: "asc" },
    });

    const bySource = funnels.reduce<Record<string, { impressions: number; pageViews: number; downloads: number }>>((acc, f) => {
      const k = f.source;
      if (!acc[k]) acc[k] = { impressions: 0, pageViews: 0, downloads: 0 };
      acc[k].impressions += f.impressions;
      acc[k].pageViews += f.pageViews;
      acc[k].downloads += f.downloads;
      return acc;
    }, {});

    const anomalies: FunnelDiagnostic[] = detectFunnelAnomalies(
      snapshots.map((s) => ({
        date: s.date,
        impressions: s.impressions,
        pageViews: s.pageViews,
        downloads: s.downloads,
      })),
    );

    return NextResponse.json({
      app: { id: app.id, appName: app.appName, platform: app.platform },
      range,
      territory,
      daily: snapshots.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        impressions: s.impressions,
        pageViews: s.pageViews,
        downloads: s.downloads,
        firstTimeDownloads: s.firstTimeDownloads,
        redownloads: s.redownloads,
        sessions: s.sessions,
        activeDevices1d: s.activeDevices1d,
        activeDevices7d: s.activeDevices7d,
        activeDevices30d: s.activeDevices30d,
        crashes: s.crashes,
        pvcrPct: Number(s.pvcrPct),
      })),
      bySource,
      anomalies,
    });
  });
});
