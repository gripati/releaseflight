/**
 * PATCH  /api/v1/apps/[id]/aso/competitors/[competitorId]
 *   Update bucket / monitor / notes / appName on a tracked competitor.
 *
 * DELETE /api/v1/apps/[id]/aso/competitors/[competitorId]
 *   Stop tracking — cascade-deletes CompetitorRank history too.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string; competitorId: string }>;
}

const UpdateCompetitor = z.object({
  appName: z.string().trim().min(1).max(200).optional(),
  bucket: z.enum(["PRIMARY", "SECONDARY", "WATCH"]).optional(),
  monitor: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const dynamic = "force-dynamic";

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, competitorId } = await context.params;
  const body = UpdateCompetitor.parse(await req.json());

  return withTenantContext(async () => {
    const existing = await prisma.competitor.findFirst({
      where: { id: competitorId, appId: id },
    });
    if (!existing) throw new NotFoundError("Competitor not found");

    const updated = await prisma.competitor.update({
      where: { id: competitorId },
      data: {
        appName: body.appName ?? existing.appName,
        bucket: body.bucket ?? existing.bucket,
        monitor: body.monitor ?? existing.monitor,
        notes: body.notes ?? existing.notes,
      },
    });
    await recordAudit({
      action: "aso.competitor.update",
      target: `competitor:${updated.id}`,
      outcome: "SUCCESS",
      appId: id,
      diff: {
        appName: updated.appName,
        bucket: updated.bucket,
        monitor: updated.monitor,
      },
    });
    return NextResponse.json({
      id: updated.id,
      appName: updated.appName,
      bucket: updated.bucket,
      monitor: updated.monitor,
      notes: updated.notes,
    });
  });
});

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, competitorId } = await context.params;

  return withTenantContext(async () => {
    const existing = await prisma.competitor.findFirst({
      where: { id: competitorId, appId: id },
    });
    if (!existing) throw new NotFoundError("Competitor not found");

    await prisma.competitor.delete({ where: { id: competitorId } });
    await recordAudit({
      action: "aso.competitor.delete",
      target: `competitor:${competitorId}`,
      outcome: "SUCCESS",
      appId: id,
      diff: {
        appName: existing.appName,
        bundleId: existing.bundleId,
        storeAppId: existing.storeAppId,
      },
    });
    return NextResponse.json({ ok: true });
  });
});
