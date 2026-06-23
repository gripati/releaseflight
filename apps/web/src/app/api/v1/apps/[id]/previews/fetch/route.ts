import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") throw new ValidationError("App previews are iOS-only");
    if (!app.versionId) return NextResponse.json({ ok: false, message: "No active version" });

    const stack = await buildAppleStack(app.credentialId);
    const grouped = await stack.screenshots.fetchAllPreviews(app.versionId);
    const discovered = new Set<string>();
    let counted = 0;

    // The AppPreview model has no composite unique index suitable for
    // upsert(), so we identify rows by Apple's stable preview id (when
    // present) and fall back to the (locale, previewType, ordinal) slot.
    for (const [locale, byType] of grouped) {
      for (const [previewType, items] of byType) {
        discovered.add(previewType);
        let ordinal = 1;
        for (const item of items) {
          counted += 1;
          const existing = await prisma.appPreview.findFirst({
            where: item.id
              ? { appId: id, applePreviewId: item.id }
              : { appId: id, locale, applePreviewType: previewType, ordinal },
            select: { id: true },
          });
          const data = {
            applePreviewId: item.id,
            fileName: item.fileName,
            state: (item.state === "COMPLETE" ? "COMPLETE" : "PROCESSING") as
              | "COMPLETE"
              | "PROCESSING",
            upstreamVideoUrl: item.videoUrl,
            upstreamPosterUrl: item.posterUrl,
            fileSize: item.fileSize,
            mimeType: item.mimeType,
            uploadedAt: new Date(),
          };
          if (existing) {
            await prisma.appPreview.update({ where: { id: existing.id }, data });
          } else {
            await prisma.appPreview.create({
              data: {
                ...data,
                tenantId: app.tenantId,
                appId: id,
                locale,
                applePreviewType: previewType,
                ordinal,
              },
            });
          }
          ordinal += 1;
        }
      }
    }

    await prisma.app.update({
      where: { id },
      data: { discoveredPreviewTypes: [...discovered], lastFetchedAt: new Date() },
    });

    await recordAudit({
      action: "preview.fetch",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { count: counted, previewTypes: [...discovered] },
    });
    return NextResponse.json({ ok: true, count: counted, previewTypes: [...discovered] });
  });
});
