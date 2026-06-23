import { NextResponse, type NextRequest } from "next/server";
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
  const locale = url.searchParams.get("locale");
  const displayType = url.searchParams.get("displayType");

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const screenshots = await prisma.screenshot.findMany({
      where: {
        appId: id,
        ...(locale ? { locale } : {}),
        ...(displayType
          ? app.platform === "IOS"
            ? { appleDisplayType: displayType }
            : { googleImageType: displayType }
          : {}),
      },
      orderBy: [{ locale: "asc" }, { ordinal: "asc" }],
    });

    return NextResponse.json({
      app: {
        id: app.id,
        platform: app.platform,
        discoveredScreenshotTypes: app.discoveredScreenshotTypes,
        availableLanguages: app.availableLanguages,
        versionId: app.versionId,
        primaryLocale: app.primaryLocale,
      },
      screenshots: screenshots.map((s) => ({
        id: s.id,
        locale: s.locale,
        appleScreenshotId: s.appleScreenshotId,
        googleImageId: s.googleImageId,
        displayType: s.appleDisplayType ?? s.googleImageType,
        fileName: s.fileName,
        width: s.width,
        height: s.height,
        ordinal: s.ordinal,
        state: s.state,
        thumbnailKey: s.thumbnailKey,
        storageKey: s.storageKey,
        upstreamUrl: s.upstreamUrl,
        fileSize: s.fileSize,
        uploadedAt: s.uploadedAt?.toISOString() ?? null,
      })),
    });
  });
});
