import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError } from "@marquee/core";
import { storage } from "@marquee/storage";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string; pvId: string }>;
}

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, pvId } = await context.params;

  return withTenantContext(async () => {
    const pv = await prisma.appPreview.findUnique({ where: { id: pvId } });
    if (pv?.appId !== id) throw new NotFoundError("Preview not found");
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    if (pv.applePreviewId) {
      const stack = await buildAppleStack(app.credentialId);
      await stack.screenshots.deleteAppPreview(pv.applePreviewId).catch(() => {
        /* best-effort */
      });
    }
    if (pv.storageKey) await storage.delete(pv.storageKey).catch(() => undefined);
    if (pv.thumbnailKey) await storage.delete(pv.thumbnailKey).catch(() => undefined);
    await prisma.appPreview.delete({ where: { id: pvId } });

    await recordAudit({
      action: "preview.delete",
      target: `app:${id}:preview:${pvId}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { locale: pv.locale, previewType: pv.applePreviewType },
    });

    return new NextResponse(null, { status: 204 });
  });
});
