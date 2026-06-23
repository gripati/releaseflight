import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ReleaseType } from "@prisma/client";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertAppAccess } from "@/lib/auth-helpers";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PatchApp = z.object({
  appName: z.string().min(1).max(80).optional(),
  versionString: z.string().min(1).max(40).optional(),
  releaseType: z.nativeEnum(ReleaseType).optional(),
  earliestReleaseDate: z.string().datetime().nullable().optional(),
  copyright: z.string().max(200).optional(),
});

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  return withTenantContext(async (ctx) => {
    assertAppAccess(ctx.allowedAppIds, id);
    // Defense-in-depth: scope by tenantId explicitly so an RLS regression
    // cannot turn a bare id lookup into a cross-tenant read (IDOR).
    const app = await prisma.app.findFirst({
      where: { id, tenantId: ctx.tenant!.id },
      include: {
        credential: { select: { id: true, kind: true, name: true } },
        _count: { select: { localizations: true, screenshots: true, appPreviews: true } },
      },
    });
    if (!app) throw new NotFoundError("App not found");
    return NextResponse.json({ app });
  });
});

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  assertAppAccess(ctx.allowedAppIds, id);
  const body = PatchApp.parse(await req.json());

  return withTenantContext(async () => {
    const before = await prisma.app.findFirst({ where: { id, tenantId: ctx.tenant!.id } });
    if (!before) throw new NotFoundError("App not found");
    const updated = await prisma.app.update({
      where: { id },
      data: {
        ...body,
        earliestReleaseDate:
          body.earliestReleaseDate === null
            ? null
            : body.earliestReleaseDate
              ? new Date(body.earliestReleaseDate)
              : undefined,
      },
    });
    await recordAudit({
      action: "app.update",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { before: { ...before }, after: { ...updated } },
    });
    return NextResponse.json({ id: updated.id });
  });
});

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "ADMIN");
  const { id } = await context.params;
  assertAppAccess(ctx.allowedAppIds, id);

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id, tenantId: ctx.tenant!.id } });
    if (!app) throw new NotFoundError("App not found");
    await prisma.app.delete({ where: { id } });
    await recordAudit({
      action: "app.delete",
      target: `app:${id}`,
      outcome: "SUCCESS",
      diff: { bundleId: app.bundleId, platform: app.platform },
    });
    return new NextResponse(null, { status: 204 });
  });
});
