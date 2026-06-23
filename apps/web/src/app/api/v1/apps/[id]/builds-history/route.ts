import { NextResponse, type NextRequest } from "next/server";
import type { BuildSummaryDto } from "@marquee/api-contracts";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id: appId } = await context.params;
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? "50"), 200);

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");

    const builds = await prisma.build.findMany({
      where: { appId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const dto: BuildSummaryDto[] = builds.map((b) => ({
      id: b.id,
      jobId: b.jobId,
      platform: b.platform,
      target: b.target,
      frameworkDetected: b.frameworkDetected,
      status: b.status,
      versionString: b.versionString,
      buildNumber: b.buildNumber,
      artifactKind: b.artifactKind,
      artifactAvailable: b.status === "DONE" && Boolean(b.artifactStorageKey),
      deployResult: (b.deployResult as Record<string, unknown> | null) ?? null,
      errorSummary: b.errorSummary,
      createdAt: b.createdAt.toISOString(),
      finishedAt: b.finishedAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ builds: dto });
  });
});
