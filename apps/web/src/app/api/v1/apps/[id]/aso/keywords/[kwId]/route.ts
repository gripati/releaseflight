/**
 * PATCH  /api/v1/apps/[id]/aso/keywords/[kwId]   Update status / notes
 * DELETE /api/v1/apps/[id]/aso/keywords/[kwId]   Archive a tracked keyword
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string; kwId: string }>;
}

/** Allowed tag tokens. "own" = my own keyword, "competitor" = mined
 *  from competitor metadata, "watch" = informational watchlist. We
 *  reject free-form tags so the UI / filter logic stays trustworthy. */
const TAG_TOKEN = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (s) => ["own", "competitor", "watch", "brand", "painkiller"].includes(s),
    "tag must be one of: own, competitor, watch, brand, painkiller",
  );

const UpdateKeyword = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
  notes: z.string().trim().max(500).optional(),
  tags: z.array(TAG_TOKEN).max(8).optional(),
});

export const dynamic = "force-dynamic";

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, kwId } = await context.params;
  const body = UpdateKeyword.parse(await req.json());

  return withTenantContext(async () => {
    const existing = await prisma.trackedKeyword.findFirst({
      where: { id: kwId, appId: id },
    });
    if (!existing) throw new NotFoundError("Tracked keyword not found");

    const nextTags = body.tags
      ? Array.from(new Set(body.tags))
      : existing.tags;
    const updated = await prisma.trackedKeyword.update({
      where: { id: kwId },
      data: {
        status: body.status ?? existing.status,
        notes: body.notes ?? existing.notes,
        tags: { set: nextTags },
      },
    });
    await recordAudit({
      action: "aso.keyword.update",
      target: `keyword:${updated.id}`,
      outcome: "SUCCESS",
      appId: id,
      diff: { status: updated.status, notes: updated.notes, tags: updated.tags },
    });
    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      notes: updated.notes,
      tags: updated.tags,
    });
  });
});

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, kwId } = await context.params;

  return withTenantContext(async () => {
    const existing = await prisma.trackedKeyword.findFirst({
      where: { id: kwId, appId: id },
    });
    if (!existing) throw new NotFoundError("Tracked keyword not found");

    await prisma.trackedKeyword.delete({ where: { id: kwId } });
    await recordAudit({
      action: "aso.keyword.delete",
      target: `keyword:${kwId}`,
      outcome: "SUCCESS",
      appId: id,
      diff: { keyword: existing.keyword, territory: existing.territory },
    });
    return NextResponse.json({ ok: true });
  });
});
