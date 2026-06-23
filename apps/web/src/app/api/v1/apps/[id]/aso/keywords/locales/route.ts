/**
 * GET /api/v1/apps/[id]/aso/keywords/locales
 *
 * One row per locale on the app:
 *   • locale meta (flag + display name)
 *   • current `keywords` field (raw + tokenised + char count vs 100)
 *   • tracked keywords for that locale (their latest score + bucket)
 *   • dirty flag + last pushed timestamp
 *
 * Drives the new per-locale keyword management UI.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import { parseKeywordsField, deriveTerritory } from "@/lib/keywordsFromMetadata";
import { localeMeta } from "@/lib/localeMeta";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, appName: true, platform: true, primaryLocale: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const [localizations, trackedKeywords] = await Promise.all([
      prisma.appLocalization.findMany({
        where: { appId: id },
        orderBy: { locale: "asc" },
        select: {
          locale: true,
          name: true,
          subtitle: true,
          keywords: true,
          promotionalText: true,
          description: true,
          dirty: true,
          lastPushedAt: true,
        },
      }),
      prisma.trackedKeyword.findMany({
        where: { appId: id, status: { not: "ARCHIVED" } },
        include: { signals: { orderBy: { date: "desc" }, take: 1 } },
      }),
    ]);

    // Build per-territory keyword lookup so each locale can pull its own.
    const trackedByTerritory = new Map<string, typeof trackedKeywords>();
    for (const k of trackedKeywords) {
      const arr = trackedByTerritory.get(k.territory) ?? [];
      arr.push(k);
      trackedByTerritory.set(k.territory, arr);
    }

    const charBudget = 100; // iOS keywords field is 100 chars max

    const locales = localizations.map((loc) => {
      const meta = localeMeta(loc.locale);
      const territory = deriveTerritory(loc.locale);
      const fieldTokens = parseKeywordsField(loc.keywords);
      const fieldTokensLower = new Set(fieldTokens.map((t) => t.toLowerCase()));

      const tracked = (trackedByTerritory.get(territory) ?? []).map((k) => {
        const latest = k.signals[0];
        return {
          id: k.id,
          keyword: k.keyword,
          status: k.status,
          source: k.source,
          inField: fieldTokensLower.has(k.keyword.toLowerCase()),
          score:
            latest?.score !== null && latest?.score !== undefined
              ? Number(latest.score)
              : null,
          bucket: latest?.bucket ?? null,
          rank: latest?.appStoreRank ?? null,
          difficulty: latest?.difficulty ?? null,
        };
      });

      const chars = (loc.keywords ?? "").length;
      return {
        locale: loc.locale,
        territory,
        meta,
        isPrimary: loc.locale === app.primaryLocale,
        keywordsField: {
          raw: loc.keywords,
          tokens: fieldTokens,
          chars,
          charBudget,
          overBudget: chars > charBudget,
          /** Suggested fit: ratio of budget used. */
          usagePct: Math.min(100, Math.round((chars / charBudget) * 100)),
        },
        name: loc.name,
        subtitle: loc.subtitle,
        promotionalText: loc.promotionalText,
        dirty: loc.dirty,
        lastPushedAt: loc.lastPushedAt?.toISOString() ?? null,
        trackedKeywords: tracked,
      };
    });

    return NextResponse.json({
      app: { id: app.id, appName: app.appName, platform: app.platform, primaryLocale: app.primaryLocale },
      locales,
    });
  });
});
