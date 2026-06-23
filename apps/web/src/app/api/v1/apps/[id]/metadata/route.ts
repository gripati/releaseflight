import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

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
      include: {
        localizations: { orderBy: { locale: "asc" } },
      },
    });
    if (!app) throw new NotFoundError("App not found");
    return NextResponse.json({
      app: {
        id: app.id,
        platform: app.platform,
        bundleId: app.bundleId,
        primaryLocale: app.primaryLocale,
        versionId: app.versionId,
        versionString: app.versionString,
        status: app.status,
        releaseType: app.releaseType,
        copyright: app.copyright,
        availableLanguages: app.availableLanguages,
        lastFetchedAt: app.lastFetchedAt?.toISOString() ?? null,
        lastPushedAt: app.lastPushedAt?.toISOString() ?? null,
      },
      localizations: app.localizations.map((l) => ({
        id: l.id,
        locale: l.locale,
        name: l.name,
        subtitle: l.subtitle,
        description: l.description,
        keywords: l.keywords,
        whatsNew: l.whatsNew,
        promotionalText: l.promotionalText,
        marketingUrl: l.marketingUrl,
        supportUrl: l.supportUrl,
        privacyPolicyUrl: l.privacyPolicyUrl,
        shortDescription: l.shortDescription,
        videoUrl: l.videoUrl,
        dirty: l.dirty,
        lastFetchedAt: l.lastFetchedAt?.toISOString() ?? null,
        lastPushedAt: l.lastPushedAt?.toISOString() ?? null,
      })),
    });
  });
});
