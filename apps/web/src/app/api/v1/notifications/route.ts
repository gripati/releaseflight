/**
 * GET /api/v1/notifications
 *   Tenant-wide notification feed for the bell. Supports filtering by
 *   severity / read-state / app / date and returns an unread count
 *   roll-up so the badge can render without a second query.
 *
 * Query params:
 *   ?unread=true              → only unread (default: all)
 *   ?severity=danger          → comma list (default: all)
 *   ?appId=<uuid>             → filter to one app
 *   ?since=YYYY-MM-DD         → from date (default: 30 days ago)
 *   ?limit=N                  → 1..200, default 50
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

const SEVERITIES = new Set(["info", "warning", "danger"]);

export const GET = withApiErrors(async (req: NextRequest) => {
  await requireTenant();
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const sevCsv = url.searchParams.get("severity");
  const appId = url.searchParams.get("appId");
  const sinceParam = url.searchParams.get("since");
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1, 200);

  const severities = sevCsv
    ? sevCsv.split(",").map((s) => s.trim().toLowerCase()).filter((s) => SEVERITIES.has(s))
    : null;

  const since =
    sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)
      ? new Date(sinceParam)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return withTenantContext(async () => {
    const where = {
      ...(appId ? { appId } : {}),
      ...(severities && severities.length > 0 ? { severity: { in: severities } } : {}),
      ...(unreadOnly ? { readAt: null } : {}),
      createdAt: { gte: since },
    };

    const [rows, totalUnread, perAppUnread] = await Promise.all([
      prisma.asoNotification.findMany({
        where,
        orderBy: [{ readAt: "asc" }, { severity: "desc" }, { createdAt: "desc" }],
        take: limit,
        include: {
          app: { select: { id: true, appName: true, bundleId: true, platform: true } },
        },
      }),
      prisma.asoNotification.count({ where: { readAt: null } }),
      prisma.asoNotification.groupBy({
        by: ["appId", "severity"],
        where: { readAt: null },
        _count: { _all: true },
      }),
    ]);

    return NextResponse.json({
      notifications: rows.map((n) => ({
        id: n.id,
        severity: n.severity,
        title: n.title,
        message: n.message,
        payload: n.payload,
        trackedKeywordId: n.trackedKeywordId,
        competitorId: n.competitorId,
        agentInterpretation: n.agentInterpretation,
        agentProbableCause: n.agentProbableCause,
        agentNextAction: n.agentNextAction,
        agentConfidence: n.agentConfidence,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
        app: {
          id: n.app.id,
          appName: n.app.appName,
          bundleId: n.app.bundleId,
          platform: n.app.platform,
        },
      })),
      totalUnread,
      perAppUnread: perAppUnread.map((p) => ({
        appId: p.appId,
        severity: p.severity,
        count: p._count._all,
      })),
    });
  });
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
