import { NextResponse, type NextRequest } from "next/server";
import { UpdateBuildConfigRequest, type BuildConfigDto } from "@marquee/api-contracts";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function toDto(
  appId: string,
  cfg:
    | {
        localPath: string | null;
        gitRef: string;
        workdirSubpath: string | null;
        iosScheme: string | null;
        versionName: string | null;
        nextBuildNumber: number | null;
        autoIncrementBuildNumber: boolean;
      }
    | null,
): BuildConfigDto {
  return {
    appId,
    source: cfg?.localPath ? "LOCAL" : "GIT",
    localPath: cfg?.localPath ?? null,
    gitRef: cfg?.gitRef ?? "main",
    workdirSubpath: cfg?.workdirSubpath ?? null,
    iosScheme: cfg?.iosScheme ?? null,
    versionName: cfg?.versionName ?? null,
    nextBuildNumber: cfg?.nextBuildNumber ?? null,
    autoIncrementBuildNumber: cfg?.autoIncrementBuildNumber ?? true,
  };
}

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id: appId } = await context.params;
  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");
    const cfg = await prisma.appBuildConfig.findUnique({ where: { appId } });
    return NextResponse.json({ config: toDto(appId, cfg) });
  });
});

export const PUT = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id: appId } = await context.params;
  const body = UpdateBuildConfigRequest.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");

    const data = {
      ...(body.localPath !== undefined ? { localPath: body.localPath } : {}),
      ...(body.gitRef !== undefined ? { gitRef: body.gitRef } : {}),
      ...(body.workdirSubpath !== undefined ? { workdirSubpath: body.workdirSubpath } : {}),
      ...(body.iosScheme !== undefined ? { iosScheme: body.iosScheme } : {}),
      ...(body.versionName !== undefined ? { versionName: body.versionName } : {}),
      ...(body.nextBuildNumber !== undefined ? { nextBuildNumber: body.nextBuildNumber } : {}),
      ...(body.autoIncrementBuildNumber !== undefined
        ? { autoIncrementBuildNumber: body.autoIncrementBuildNumber }
        : {}),
    };

    const cfg = await prisma.appBuildConfig.upsert({
      where: { appId },
      create: {
        tenantId: ctx.tenant!.id,
        appId,
        localPath: body.localPath ?? null,
        gitRef: body.gitRef ?? "main",
        workdirSubpath: body.workdirSubpath ?? null,
        iosScheme: body.iosScheme ?? null,
        createdById: ctx.user.id,
      },
      update: data,
    });

    return NextResponse.json({ config: toDto(appId, cfg) });
  });
});
