import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext { params: Promise<{ id: string }> }

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const locale = url.searchParams.get("locale");
  const previewType = url.searchParams.get("previewType");

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const previews = await prisma.appPreview.findMany({
      where: {
        appId: id,
        ...(locale ? { locale } : {}),
        ...(previewType ? { applePreviewType: previewType } : {}),
      },
      orderBy: [{ locale: "asc" }, { ordinal: "asc" }],
    });

    return NextResponse.json({
      app: {
        id: app.id,
        platform: app.platform,
        availableLanguages: app.availableLanguages,
        discoveredPreviewTypes: app.discoveredPreviewTypes,
        versionId: app.versionId,
        primaryLocale: app.primaryLocale,
      },
      previews: previews.map((p) => ({
        id: p.id,
        locale: p.locale,
        previewType: p.applePreviewType,
        fileName: p.fileName,
        width: p.width,
        height: p.height,
        ordinal: p.ordinal,
        state: p.state,
        storageKey: p.storageKey,
        thumbnailKey: p.thumbnailKey,
        upstreamVideoUrl: p.upstreamVideoUrl,
        upstreamPosterUrl: p.upstreamPosterUrl,
        mimeType: p.mimeType,
        fileSize: p.fileSize,
        uploadedAt: p.uploadedAt?.toISOString() ?? null,
      })),
    });
  });
});
