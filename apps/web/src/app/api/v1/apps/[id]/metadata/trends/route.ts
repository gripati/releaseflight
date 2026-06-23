/**
 * GET /api/v1/apps/[id]/metadata/trends
 *
 * Comprehensive trends dashboard data for the metadata workbench. Returns
 * a 30-day rollup of every signal we capture from App Store Connect:
 *
 *   • Headline KPIs: downloads, impressions, page views, PVCR, sessions,
 *     active devices (1d/7d/30d), first-time vs redownloads, crashes.
 *     Each comes with a previous-30-day comparator so the UI can show
 *     the delta.
 *   • Daily time series so the UI can spark-chart any of those.
 *   • Acquisition funnel by source (SEARCH / BROWSE / APP_REFERRER /
 *     WEB_REFERRER / INSTITUTIONAL / UNAVAILABLE).
 *   • Top territories by 30-day downloads (with share %).
 *   • Top devices (iPhone / iPad / Desktop / Apple TV) parsed out of the
 *     Sales-Reports payload that lives in rawJson.
 *   • Setup hints: which credential is wired up, whether vendor number
 *     is missing — so the UI can show an actionable empty state instead
 *     of a silent "0 downloads".
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, platform: true, credentialId: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const since30 = daysAgo(30);
    const since60 = daysAgo(60);
    const today = startOfUtcDay(new Date());

    const [snapshots, prevSnapshots, funnels, lastSnap, credential, lastSync] = await Promise.all([
      prisma.analyticsSnapshot.findMany({
        where: { appId: id, date: { gte: since30, lt: today } },
        orderBy: { date: "asc" },
        select: {
          date: true,
          impressions: true,
          pageViews: true,
          downloads: true,
          firstTimeDownloads: true,
          redownloads: true,
          sessions: true,
          activeDevices1d: true,
          activeDevices7d: true,
          activeDevices30d: true,
          crashes: true,
          pvcrPct: true,
          rawJson: true,
        },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { appId: id, date: { gte: since60, lt: since30 } },
        select: {
          impressions: true,
          pageViews: true,
          downloads: true,
          firstTimeDownloads: true,
          redownloads: true,
          sessions: true,
          activeDevices30d: true,
          crashes: true,
        },
      }),
      prisma.analyticsFunnel.findMany({
        where: { appId: id, date: { gte: since30, lt: today } },
        select: { source: true, territory: true, downloads: true, impressions: true, pageViews: true },
      }),
      prisma.analyticsSnapshot.findFirst({
        where: { appId: id },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      app.credentialId
        ? prisma.credential.findUnique({
            where: { id: app.credentialId },
            select: { id: true, kind: true, name: true, appleVendorNumber: true },
          })
        : Promise.resolve(null),
      prisma.job.findFirst({
        where: { appId: id, kind: "aso.analytics.sync" },
        orderBy: { createdAt: "desc" },
        select: { status: true, createdAt: true, finishedAt: true, error: true },
      }),
    ]);

    // ── 30-day totals + averages ─────────────────────────────────────
    const totals = sumSnapshots(snapshots);
    const prevTotals = sumSnapshots(prevSnapshots);

    const avgPvcr =
      totals.pageViews > 0 ? (totals.downloads / totals.pageViews) * 100 : null;
    const prevAvgPvcr =
      prevTotals.pageViews > 0 ? (prevTotals.downloads / prevTotals.pageViews) * 100 : null;

    // Active devices is a SNAPSHOT, not a sum — take the most recent.
    const latestActiveDevices = snapshots.length > 0
      ? {
          oneDay: snapshots[snapshots.length - 1]!.activeDevices1d,
          sevenDay: snapshots[snapshots.length - 1]!.activeDevices7d,
          thirtyDay: snapshots[snapshots.length - 1]!.activeDevices30d,
        }
      : { oneDay: 0, sevenDay: 0, thirtyDay: 0 };
    const earliestActiveDevices30d =
      snapshots.length > 0 ? snapshots[0]!.activeDevices30d : null;
    const activeDevices30dDelta =
      earliestActiveDevices30d && earliestActiveDevices30d > 0
        ? ((latestActiveDevices.thirtyDay - earliestActiveDevices30d) / earliestActiveDevices30d) *
          100
        : null;

    // ── Acquisition funnel by source (excluding the "ALL" Sales-Reports
    //    synthesised rows so we only chart what's truly per-source). ─
    const sourceTotals = new Map<string, { downloads: number; impressions: number; pageViews: number }>();
    for (const f of funnels) {
      if (f.source === "ALL") continue;
      const cur = sourceTotals.get(f.source) ?? { downloads: 0, impressions: 0, pageViews: 0 };
      cur.downloads += f.downloads;
      cur.impressions += f.impressions;
      cur.pageViews += f.pageViews;
      sourceTotals.set(f.source, cur);
    }
    const sourceDownloadsTotal = [...sourceTotals.values()].reduce((s, v) => s + v.downloads, 0);
    const sources = [...sourceTotals.entries()]
      .map(([source, v]) => ({
        source,
        downloads: v.downloads,
        impressions: v.impressions,
        pageViews: v.pageViews,
        sharePct: sourceDownloadsTotal > 0 ? (v.downloads / sourceDownloadsTotal) * 100 : 0,
      }))
      .sort((a, b) => b.downloads - a.downloads);

    // ── Top territories — fall back to "ALL" rows when no per-source
    //    breakdown exists (Sales-Reports-only path). ─────────────────
    const territoryTotals = new Map<string, number>();
    const hasSourceTerritories = funnels.some((f) => f.source !== "ALL" && f.territory.length === 2);
    for (const f of funnels) {
      if (hasSourceTerritories && f.source === "ALL") continue;
      if (!hasSourceTerritories && f.source !== "ALL") continue;
      if (f.territory.length !== 2) continue;
      territoryTotals.set(f.territory, (territoryTotals.get(f.territory) ?? 0) + f.downloads);
    }
    const territoryDownloadsTotal = [...territoryTotals.values()].reduce((s, v) => s + v, 0);
    const topTerritories = [...territoryTotals.entries()]
      .map(([territory, downloads]) => ({
        territory,
        downloads,
        sharePct: territoryDownloadsTotal > 0 ? (downloads / territoryDownloadsTotal) * 100 : 0,
      }))
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 8);

    // ── Top devices — Sales Reports rawJson carries a per-device map.
    const deviceTotals = new Map<string, number>();
    for (const s of snapshots) {
      const parsed = parseDevices(s.rawJson);
      for (const [device, units] of parsed) {
        if (!device) continue;
        deviceTotals.set(device, (deviceTotals.get(device) ?? 0) + units);
      }
    }
    const deviceDownloadsTotal = [...deviceTotals.values()].reduce((s, v) => s + v, 0);
    const topDevices = [...deviceTotals.entries()]
      .map(([device, downloads]) => ({
        device,
        downloads,
        sharePct: deviceDownloadsTotal > 0 ? (downloads / deviceDownloadsTotal) * 100 : 0,
      }))
      .sort((a, b) => b.downloads - a.downloads);

    // ── Daily series for the spark charts ───────────────────────────
    const dailySeries = snapshots.map((s) => ({
      date: toIsoDate(s.date),
      downloads: s.downloads,
      impressions: s.impressions,
      pageViews: s.pageViews,
      firstTimeDownloads: s.firstTimeDownloads,
      redownloads: s.redownloads,
      sessions: s.sessions,
      crashes: s.crashes,
    }));

    const vendorNumberMissing =
      app.platform === "IOS" &&
      credential?.kind === "APPLE" &&
      (credential.appleVendorNumber ?? "").trim().length === 0;

    // Inspect the actual rawJson source per snapshot so the UI can
    // tell the user which data sources are currently feeding them
    // (and which are still waiting on Apple).
    const sourcesUsed = new Set<string>();
    for (const s of snapshots) {
      const src = (s.rawJson as { source?: string } | null)?.source;
      sourcesUsed.add(src ?? "analytics-reports");
    }
    const salesActive = sourcesUsed.has("sales-reports");
    const analyticsActive = totals.impressions > 0 || totals.pageViews > 0;
    const daysWithDownloads = snapshots.filter((s) => s.downloads > 0).length;
    const daysWithAnalytics = snapshots.filter(
      (s) => s.impressions > 0 || s.pageViews > 0 || s.sessions > 0,
    ).length;

    const analyticsRampingUp =
      app.platform === "IOS" &&
      !vendorNumberMissing &&
      totals.downloads > 0 &&
      !analyticsActive;

    return NextResponse.json({
      kpis: {
        downloads: {
          value: totals.downloads,
          prevValue: prevTotals.downloads,
          deltaPct: deltaPct(totals.downloads, prevTotals.downloads),
        },
        impressions: {
          value: totals.impressions,
          prevValue: prevTotals.impressions,
          deltaPct: deltaPct(totals.impressions, prevTotals.impressions),
        },
        pageViews: {
          value: totals.pageViews,
          prevValue: prevTotals.pageViews,
          deltaPct: deltaPct(totals.pageViews, prevTotals.pageViews),
        },
        pvcrPct: {
          value: avgPvcr,
          prevValue: prevAvgPvcr,
          deltaPp:
            avgPvcr !== null && prevAvgPvcr !== null ? avgPvcr - prevAvgPvcr : null,
        },
        sessions: {
          value: totals.sessions,
          prevValue: prevTotals.sessions,
          deltaPct: deltaPct(totals.sessions, prevTotals.sessions),
        },
        firstTimeDownloads: {
          value: totals.firstTimeDownloads,
          prevValue: prevTotals.firstTimeDownloads,
          deltaPct: deltaPct(totals.firstTimeDownloads, prevTotals.firstTimeDownloads),
        },
        redownloads: {
          value: totals.redownloads,
          prevValue: prevTotals.redownloads,
          deltaPct: deltaPct(totals.redownloads, prevTotals.redownloads),
        },
        activeDevices30d: {
          value: latestActiveDevices.thirtyDay,
          oneDay: latestActiveDevices.oneDay,
          sevenDay: latestActiveDevices.sevenDay,
          deltaPct: activeDevices30dDelta,
        },
        crashes: {
          value: totals.crashes,
          prevValue: prevTotals.crashes,
          deltaPct: deltaPct(totals.crashes, prevTotals.crashes),
        },
      },
      dailySeries,
      sources,
      topTerritories,
      topDevices,
      lastSyncedAt: lastSnap?.date ? toIsoDate(lastSnap.date) : null,
      lastSyncJob: lastSync
        ? {
            status: lastSync.status,
            createdAt: lastSync.createdAt.toISOString(),
            finishedAt: lastSync.finishedAt ? lastSync.finishedAt.toISOString() : null,
            error: lastSync.error,
          }
        : null,
      setup: {
        platform: app.platform,
        credentialId: credential?.id ?? null,
        credentialKind: credential?.kind ?? null,
        credentialName: credential?.name ?? null,
        vendorNumberMissing,
        analyticsRampingUp,
      },
      dataSources: {
        sales: {
          active: salesActive,
          daysWithData: daysWithDownloads,
          totalDownloads: totals.downloads,
          territoriesCount: territoryTotals.size,
          devicesCount: deviceTotals.size,
        },
        analytics: {
          active: analyticsActive,
          daysWithData: daysWithAnalytics,
          totalImpressions: totals.impressions,
          totalPageViews: totals.pageViews,
          totalSessions: totals.sessions,
          sourcesBreakdownCount: sources.length,
        },
      },
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

interface SnapshotSummable {
  impressions: number;
  pageViews: number;
  downloads: number;
  firstTimeDownloads: number;
  redownloads: number;
  sessions: number;
  crashes: number;
}

function sumSnapshots(rows: SnapshotSummable[]): SnapshotSummable {
  return rows.reduce(
    (acc, r) => ({
      impressions: acc.impressions + r.impressions,
      pageViews: acc.pageViews + r.pageViews,
      downloads: acc.downloads + r.downloads,
      firstTimeDownloads: acc.firstTimeDownloads + r.firstTimeDownloads,
      redownloads: acc.redownloads + r.redownloads,
      sessions: acc.sessions + r.sessions,
      crashes: acc.crashes + r.crashes,
    }),
    {
      impressions: 0,
      pageViews: 0,
      downloads: 0,
      firstTimeDownloads: 0,
      redownloads: 0,
      sessions: 0,
      crashes: 0,
    },
  );
}

/**
 * The Sales Reports adapter stores a per-device breakdown in rawJson
 * under `devices: [{ device, units }]`. Older snapshots may not have
 * it. Returns an empty map when not present.
 */
function parseDevices(raw: unknown): [string, number][] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { devices?: unknown };
  if (!Array.isArray(r.devices)) return [];
  const out: [string, number][] = [];
  for (const d of r.devices as unknown[]) {
    if (!d || typeof d !== "object") continue;
    const entry = d as { device?: unknown; units?: unknown };
    const device = typeof entry.device === "string" ? entry.device : null;
    const units = typeof entry.units === "number" ? entry.units : null;
    if (device && units !== null) out.push([device, units]);
  }
  return out;
}

function deltaPct(current: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((current - prev) / prev) * 100;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
