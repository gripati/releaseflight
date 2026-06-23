import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NotFoundError } from "@marquee/core";
import { storage } from "@marquee/storage";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string; scId: string }>;
}

const PatchBody = z.object({
  ordinal: z.number().int().min(1).max(1000),
});

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, scId } = await context.params;

  return withTenantContext(async () => {
    const sc = await prisma.screenshot.findUnique({ where: { id: scId } });
    if (sc?.appId !== id) throw new NotFoundError("Screenshot not found");

    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    // Delete on store
    if (app.platform === "IOS" && sc.appleScreenshotId) {
      const stack = await buildAppleStack(app.credentialId);
      await stack.screenshots.deleteScreenshot(sc.appleScreenshotId).catch(() => {
        /* best-effort */
      });
    } else if (app.platform === "ANDROID" && sc.googleImageId && sc.googleImageType) {
      const stack = await buildGoogleStack(app.credentialId);
      await stack.images
        .deleteImage({
          packageName: app.bundleId,
          language: sc.locale,
          imageType: sc.googleImageType as Parameters<
            typeof stack.images.deleteImage
          >[0]["imageType"],
          imageId: sc.googleImageId,
        })
        .catch(() => {
          /* best-effort */
        });
    }

    // Delete from storage
    if (sc.storageKey) await storage.delete(sc.storageKey).catch(() => undefined);
    if (sc.thumbnailKey) await storage.delete(sc.thumbnailKey).catch(() => undefined);
    await prisma.screenshot.delete({ where: { id: scId } });

    await recordAudit({
      action: "screenshot.delete",
      target: `app:${id}:screenshot:${scId}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { locale: sc.locale, displayType: sc.appleDisplayType ?? sc.googleImageType },
    });

    return new NextResponse(null, { status: 204 });
  });
});

// We expose a small PATCH endpoint to change a single ordinal — bulk reorder
// lives on /reorder/route.ts. This is mainly for client-side UX convenience.
export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;
  const { id, scId } = await context.params;
  const { ordinal } = PatchBody.parse(await req.json());

  return withTenantContext(async () => {
    const sc = await prisma.screenshot.findUnique({ where: { id: scId } });
    if (sc?.appId !== id) throw new NotFoundError("Screenshot not found");
    await prisma.screenshot.update({ where: { id: scId }, data: { ordinal } });
    return NextResponse.json({ id: scId, ordinal });
  });
});
