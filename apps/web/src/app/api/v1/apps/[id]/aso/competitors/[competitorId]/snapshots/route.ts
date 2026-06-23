/**
 * GET /api/v1/apps/[id]/aso/competitors/[competitorId]/snapshots
 *
 * Returns every territory's latest snapshot for one competitor, plus
 * the change-history timeline (last 30 days of AsoNotification rows
 * tagged with this competitorId). Powers the detail / compare modal.
 *
 * One round-trip = everything the modal needs:
 *   • Per-territory latest snapshot (screenshots, version, rating, ...)
 *   • Recent change timeline (30 days, ordered newest first)
 *   • Header denormalised mirrors (icon, name, etc) — saved on the
 *     Competitor row from the most-recent sync.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string; competitorId: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id: appId, competitorId } = await context.params;

  return withTenantContext(async () => {
    const competitor = await prisma.competitor.findFirst({
      where: { id: competitorId, appId },
    });
    if (!competitor) throw new NotFoundError("Competitor not found");

    // ── Latest snapshot per territory ──────────────────────────────
    // Over-fetch (a small number per competitor — usually 10-40
    // territories × 1 row each) and dedup in memory. Cheaper than a
    // Postgres-specific DISTINCT ON for the volume we're dealing with.
    const allSnapshots = await prisma.competitorSnapshot.findMany({
      where: { competitorId },
      orderBy: [{ territory: "asc" }, { date: "desc" }],
    });
    const latestByTerritory = new Map<string, (typeof allSnapshots)[number]>();
    for (const s of allSnapshots) {
      if (!latestByTerritory.has(s.territory)) {
        latestByTerritory.set(s.territory, s);
      }
    }

    // ── 30-day change timeline ─────────────────────────────────────
    const sinceDate = new Date();
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 30);
    const changes = await prisma.asoNotification.findMany({
      where: {
        appId,
        competitorId,
        date: { gte: sinceDate },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        date: true,
        severity: true,
        title: true,
        message: true,
        payload: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      competitor: {
        id: competitor.id,
        appName: competitor.appName,
        bundleId: competitor.bundleId,
        storeAppId: competitor.storeAppId,
        iconUrl: competitor.iconUrl,
        trackUrl: competitor.trackUrl,
        sellerName: competitor.sellerName,
        primaryGenre: competitor.primaryGenre,
        ingestCountry: competitor.ingestCountry,
        latestVersion: competitor.latestVersion,
        latestRating: competitor.latestRating,
        latestRatingCount: competitor.latestRatingCount,
        lastSyncedAt: competitor.lastSyncedAt?.toISOString() ?? null,
        bucket: competitor.bucket,
        monitor: competitor.monitor,
        notes: competitor.notes,
      },
      territories: Array.from(latestByTerritory.values())
        .map((s) => ({
          territory: s.territory,
          date: s.date.toISOString().slice(0, 10),
          fetchedAt: s.fetchedAt.toISOString(),
          name: s.name,
          subtitle: s.subtitle,
          description: s.description,
          releaseNotes: s.releaseNotes,
          version: s.version,
          currentVersionReleaseDate: s.currentVersionReleaseDate?.toISOString() ?? null,
          averageUserRating: s.averageUserRating,
          userRatingCount: s.userRatingCount,
          iconUrl: s.iconUrl,
          iphoneScreenshotUrls: s.iphoneScreenshotUrls,
          ipadScreenshotUrls: s.ipadScreenshotUrls,
          sellerName: s.sellerName,
          primaryGenre: s.primaryGenre,
          genres: s.genres,
          contentAdvisoryRating: s.contentAdvisoryRating,
          minimumOsVersion: s.minimumOsVersion,
          languageCodes: s.languageCodes,
          price: s.price,
          currency: s.currency,
          formattedPrice: s.formattedPrice,
          trackUrl: s.trackUrl,
        }))
        .sort((a, b) => a.territory.localeCompare(b.territory)),
      changes: changes.map((n) => ({
        id: n.id,
        date: n.date.toISOString().slice(0, 10),
        severity: n.severity,
        title: n.title,
        message: n.message,
        payload: n.payload as Record<string, unknown>,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  });
});
