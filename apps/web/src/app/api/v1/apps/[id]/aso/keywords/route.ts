/**
 * GET  /api/v1/apps/[id]/aso/keywords        List tracked keywords + latest signal
 * POST /api/v1/apps/[id]/aso/keywords        Add a new tracked keyword (manual)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Same tag taxonomy as PATCH — kept here so create-time tagging
 *  (e.g. "track this rival keyword as competitor") is one round-trip. */
const TAG_TOKEN = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (s) => ["own", "competitor", "watch", "brand", "painkiller"].includes(s),
    "tag must be one of: own, competitor, watch, brand, painkiller",
  );

const CreateKeyword = z.object({
  keyword: z.string().trim().min(1).max(80),
  territory: z.string().trim().regex(/^[A-Z]{2}$/, "Territory must be ISO 3166-1 alpha-2").default("US"),
  source: z
    .enum(["MANUAL", "AI_SUGGESTED", "APPLE_RECOMMENDED", "COMPETITOR_BORROWED", "ASTRO_CSV"])
    .default("MANUAL"),
  notes: z.string().trim().max(500).optional(),
  tags: z.array(TAG_TOKEN).max(8).optional(),
});

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const rows = await prisma.trackedKeyword.findMany({
      where: { appId: id },
      orderBy: [{ status: "asc" }, { keyword: "asc" }],
      include: {
        signals: { orderBy: { date: "desc" }, take: 1 },
      },
    });

    return NextResponse.json({
      keywords: rows.map((k) => {
        const latest = k.signals[0];
        return {
          id: k.id,
          keyword: k.keyword,
          territory: k.territory,
          source: k.source,
          status: k.status,
          notes: k.notes,
          tags: k.tags,
          // Lineage breadcrumb for swapped-in "adopted" keywords —
          // null on default/manual rows. The UI shows this as a
          // "← previous keyword" annotation under adopted ones.
          replacedFromId: k.replacedFromId,
          replacedAt: k.replacedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
          updatedAt: k.updatedAt.toISOString(),
          latestSignal: latest
            ? {
                date: latest.date.toISOString().slice(0, 10),
                appStoreRank: latest.appStoreRank,
                volume: latest.volume,
                maxVolume: latest.maxVolume,
                difficulty: latest.difficulty,
                maxReachChance: latest.maxReachChance,
                score: latest.score !== null ? Number(latest.score) : null,
                bucket: latest.bucket,
              }
            : null,
        };
      }),
    });
  });
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = CreateKeyword.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const existing = await prisma.trackedKeyword.findUnique({
      where: {
        appId_keyword_territory: {
          appId: id,
          keyword: body.keyword,
          territory: body.territory,
        },
      },
    });
    if (existing) {
      throw new ValidationError(
        `"${body.keyword}" already tracked for ${body.territory}`,
      );
    }

    const created = await prisma.trackedKeyword.create({
      data: {
        tenantId: ctx.tenant!.id,
        appId: id,
        keyword: body.keyword,
        territory: body.territory,
        source: body.source,
        notes: body.notes,
        tags: body.tags ? Array.from(new Set(body.tags)) : [],
        createdById: ctx.user.id,
      },
    });
    await recordAudit({
      action: "aso.keyword.track",
      target: `keyword:${created.id}`,
      outcome: "SUCCESS",
      appId: id,
      diff: {
        keyword: created.keyword,
        territory: created.territory,
        source: created.source,
        tags: created.tags,
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        keyword: created.keyword,
        territory: created.territory,
        source: created.source,
        status: created.status,
        tags: created.tags,
      },
      { status: 201 },
    );
  });
});
