import { NextResponse, type NextRequest } from "next/server";
import { exportMasterJson, NotFoundError } from "@marquee/core";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext { params: Promise<{ id: string }> }

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    const locs = await prisma.appLocalization.findMany({
      where: { appId: id },
      orderBy: { locale: "asc" },
    });
    const json = exportMasterJson({
      schema: "1.0",
      comment: `Exported for ${app.appName} (${app.bundleId}) · ${new Date().toISOString()}`,
      localizations: locs.map((l) => ({
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
      })),
    });
    const slug = app.bundleId.split(".").pop() ?? "app";
    return new NextResponse(json, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${slug}-master.json"`,
      },
    });
  });
});
