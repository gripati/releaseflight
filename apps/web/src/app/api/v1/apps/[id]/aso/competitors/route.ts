/**
 * GET  /api/v1/apps/[id]/aso/competitors           List tracked competitors
 * POST /api/v1/apps/[id]/aso/competitors           Add a competitor to track
 *
 * Competitors are first-class records — every time the daily-check
 * job runs, it pulls each monitored competitor's rank on OUR tracked
 * keywords and feeds the deltas into `evaluateCompetitorIntrusion`.
 * This is the "rakip benim keyword'üme girdi mi?" loop.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Validation rules deliberately tight: bundleId looks like reverse-DNS
 *  (com.studio.app) and storeAppId is the numeric Apple ID we hand to
 *  Astro. Both are optional individually but at least one is required —
 *  without one we can't actually fetch ranks. */
const CreateCompetitor = z
  .object({
    appName: z.string().trim().min(1).max(200),
    bundleId: z
      .string()
      .trim()
      .max(200)
      .regex(/^[a-z0-9.\-_]+$/i, "Invalid bundleId format")
      .optional(),
    storeAppId: z
      .string()
      .trim()
      .regex(/^\d{6,12}$/, "storeAppId must be a 6-12 digit App Store numeric ID")
      .optional(),
    bucket: z.enum(["PRIMARY", "SECONDARY", "WATCH"]).optional(),
    monitor: z.boolean().default(true),
    notes: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => Boolean(v.bundleId) || Boolean(v.storeAppId),
    "Either bundleId or storeAppId is required",
  );

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, primaryLocale: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const { localeRegion } = await import("@marquee/core/locale");
    const homeTerritory = localeRegion(app.primaryLocale).toUpperCase();

    // ── Competitors with denormalised "latest" mirrors ────────────
    const rows = await prisma.competitor.findMany({
      where: { appId: id },
      orderBy: [{ monitor: "desc" }, { bucket: "asc" }, { appName: "asc" }],
      include: {
        competitorRanks: {
          orderBy: { date: "desc" },
          take: 5,
          select: {
            date: true,
            rank: true,
            trackedKeywordId: true,
            trackedKeyword: { select: { keyword: true } },
          },
        },
      },
    });

    const ids = rows.map((c) => c.id);

    // ── Latest snapshot per (competitor, home-territory) ──────────
    // The card list only needs the home-territory snapshot for at-a-
    // glance content (icon, screenshots, description). The detail
    // panel pulls every territory on demand via a separate endpoint.
    const homeSnapshots = ids.length
      ? await prisma.competitorSnapshot.findMany({
          where: { competitorId: { in: ids }, territory: homeTerritory },
          orderBy: [{ competitorId: "asc" }, { date: "desc" }],
          // Latest per competitor — Prisma can't `DISTINCT ON` portably
          // so we over-fetch + dedup in memory. With ~50 competitors
          // max per app this is cheap.
        })
      : [];
    const latestByCompetitor = new Map<string, (typeof homeSnapshots)[number]>();
    for (const s of homeSnapshots) {
      if (!latestByCompetitor.has(s.competitorId)) {
        latestByCompetitor.set(s.competitorId, s);
      }
    }

    // ── Recent change notifications (last 7 days) per competitor ──
    // Drives the "3 changes this week" pill on each card. We pull the
    // raw severity + title + date — the UI does the grouping/styling.
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
    const recentChanges = ids.length
      ? await prisma.asoNotification.findMany({
          where: {
            appId: id,
            competitorId: { in: ids },
            date: { gte: sevenDaysAgo },
          },
          orderBy: { date: "desc" },
          select: {
            id: true,
            competitorId: true,
            date: true,
            severity: true,
            title: true,
            message: true,
            payload: true,
          },
        })
      : [];
    const changesByCompetitor = new Map<string, typeof recentChanges>();
    for (const n of recentChanges) {
      if (!n.competitorId) continue;
      const arr = changesByCompetitor.get(n.competitorId) ?? [];
      arr.push(n);
      changesByCompetitor.set(n.competitorId, arr);
    }

    return NextResponse.json({
      homeTerritory,
      competitors: rows.map((c) => {
        const snap = latestByCompetitor.get(c.id) ?? null;
        const changes = changesByCompetitor.get(c.id) ?? [];
        return {
          id: c.id,
          appName: c.appName,
          bundleId: c.bundleId,
          storeAppId: c.storeAppId,
          bucket: c.bucket,
          monitor: c.monitor,
          notes: c.notes,
          // Denormalised mirrors from the most recent sync.
          iconUrl: c.iconUrl,
          trackUrl: c.trackUrl,
          sellerName: c.sellerName,
          primaryGenre: c.primaryGenre,
          ingestCountry: c.ingestCountry,
          latestVersion: c.latestVersion,
          latestRating: c.latestRating,
          latestRatingCount: c.latestRatingCount,
          lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
          recentRanks: c.competitorRanks.map((r) => ({
            date: r.date.toISOString().slice(0, 10),
            rank: r.rank,
            trackedKeywordId: r.trackedKeywordId,
            keyword: r.trackedKeyword.keyword,
          })),
          // Most-recent snapshot for the operator's primary
          // territory — feeds the card preview (screenshots, current
          // description, etc.) without a join per card.
          homeSnapshot: snap
            ? {
                territory: snap.territory,
                date: snap.date.toISOString().slice(0, 10),
                name: snap.name,
                subtitle: snap.subtitle,
                description: snap.description,
                version: snap.version,
                averageUserRating: snap.averageUserRating,
                userRatingCount: snap.userRatingCount,
                iconUrl: snap.iconUrl,
                iphoneScreenshotUrls: snap.iphoneScreenshotUrls,
                ipadScreenshotUrls: snap.ipadScreenshotUrls,
                primaryGenre: snap.primaryGenre,
                price: snap.price,
                formattedPrice: snap.formattedPrice,
              }
            : null,
          recentChanges: changes.map((n) => ({
            id: n.id,
            date: n.date.toISOString().slice(0, 10),
            severity: n.severity,
            title: n.title,
            message: n.message,
            payload: n.payload as Record<string, unknown>,
          })),
        };
      }),
    });
  });
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = CreateCompetitor.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    // Composite uniqueness is (appId, bundleId). Two competitors with
    // the same bundleId on the same app would just be duplicate state.
    if (body.bundleId) {
      const dup = await prisma.competitor.findUnique({
        where: { appId_bundleId: { appId: id, bundleId: body.bundleId } },
      });
      if (dup) {
        throw new ValidationError(`Competitor "${dup.appName}" already tracked`);
      }
    }

    const created = await prisma.competitor.create({
      data: {
        tenantId: ctx.tenant!.id,
        appId: id,
        appName: body.appName,
        bundleId: body.bundleId ?? null,
        storeAppId: body.storeAppId ?? null,
        bucket: body.bucket ?? "SECONDARY",
        monitor: body.monitor,
        notes: body.notes ?? null,
        createdById: ctx.user.id,
      },
    });
    await recordAudit({
      action: "aso.competitor.create",
      target: `competitor:${created.id}`,
      outcome: "SUCCESS",
      appId: id,
      diff: {
        appName: created.appName,
        bundleId: created.bundleId,
        storeAppId: created.storeAppId,
        bucket: created.bucket,
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        appName: created.appName,
        bundleId: created.bundleId,
        storeAppId: created.storeAppId,
        bucket: created.bucket,
        monitor: created.monitor,
        notes: created.notes,
      },
      { status: 201 },
    );
  });
});
