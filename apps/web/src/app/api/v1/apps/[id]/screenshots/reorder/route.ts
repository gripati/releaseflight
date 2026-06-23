import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Locale, Uuid } from "@marquee/api-contracts";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

const ReorderBody = z.object({
  locale: Locale,
  displayType: z.string().min(1).max(80),
  orderedIds: z.array(Uuid).min(1).max(20),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;
  const { id } = await context.params;
  const body = ReorderBody.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const screenshots = await prisma.screenshot.findMany({
      where: {
        appId: id,
        locale: body.locale,
        ...(app.platform === "IOS"
          ? { appleDisplayType: body.displayType }
          : { googleImageType: body.displayType }),
      },
    });
    const known = new Set(screenshots.map((s) => s.id));
    if (body.orderedIds.length !== screenshots.length) {
      throw new ValidationError("orderedIds must include exactly all screenshots in the slot");
    }
    for (const oid of body.orderedIds) {
      if (!known.has(oid)) throw new ValidationError(`orderedIds includes unknown screenshot ${oid}`);
    }

    // Optimistic update — write DB first so the UI reflects immediately,
    // then mirror to Apple (Google reordering goes through re-uploading).
    await prisma.$transaction(
      body.orderedIds.map((sid, idx) =>
        prisma.screenshot.update({ where: { id: sid }, data: { ordinal: idx + 1 } }),
      ),
    );

    if (app.platform === "IOS") {
      const stack = await buildAppleStack(app.credentialId);
      const versionId = app.versionId;
      if (!versionId) throw new ValidationError("App has no active version");
      // Look up Apple screenshot set ID via the first screenshot's set
      const first = screenshots[0];
      if (first?.appleScreenshotSetId) {
        const appleIds = body.orderedIds
          .map((oid) => screenshots.find((s) => s.id === oid)?.appleScreenshotId ?? null)
          .filter((x): x is string => Boolean(x));
        if (appleIds.length === body.orderedIds.length) {
          await stack.screenshots.reorderScreenshots({
            setId: first.appleScreenshotSetId,
            orderedScreenshotIds: appleIds,
          });
        }
      }
    }

    await recordAudit({
      action: "screenshot.reorder",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { locale: body.locale, displayType: body.displayType, count: body.orderedIds.length },
    });

    return NextResponse.json({ ok: true });
  });
});
