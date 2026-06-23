/**
 * PATCH /api/v1/notifications/[id]
 *   Body: { read?: boolean }     mark a single notification as read or unread.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Patch = z.object({
  read: z.boolean(),
});

export const dynamic = "force-dynamic";

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  const { id } = await context.params;
  const body = Patch.parse(await req.json());

  return withTenantContext(async () => {
    const existing = await prisma.asoNotification.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError("Notification not found");

    const updated = await prisma.asoNotification.update({
      where: { id },
      data: {
        readAt: body.read ? new Date() : null,
        readById: body.read ? ctx.user.id : null,
      },
    });
    await recordAudit({
      action: body.read ? "aso.notification.read" : "aso.notification.unread",
      target: `notification:${id}`,
      outcome: "SUCCESS",
      appId: updated.appId,
    });
    return NextResponse.json({
      id: updated.id,
      readAt: updated.readAt?.toISOString() ?? null,
    });
  });
});
