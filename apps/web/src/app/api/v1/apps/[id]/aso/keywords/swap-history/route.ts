/**
 * GET /api/v1/apps/[id]/aso/keywords/swap-history
 *
 * Chronological log of every keyword swap on this app. A "swap event"
 * is any TrackedKeyword whose `replacedFromId` points at a predecessor
 * — that predecessor's archive timestamp + the successor's adoption
 * timestamp together describe one swap.
 *
 * Returns:
 *   • date           — when the swap landed (created_at on the new
 *                      adopted keyword)
 *   • territory      — storefront the swap happened in
 *   • oldKeyword     — text + last-known rank + score just before swap
 *   • newKeyword     — text + tags + current rank
 *   • notes          — optional rationale stored on the new row
 *
 * Sorted newest first. Optional `?limit=` (default 100, cap 500),
 * `?territory=US` to filter.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1, 500);
  const territoryFilter = url.searchParams.get("territory");

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    // Every "adopted" row (status ACTIVE or ARCHIVED — once swapped, a
    // swapped-in keyword can itself be swapped OUT later) carries the
    // lineage backref. Pull both sides via the `replacedFrom` include.
    const adopted = await prisma.trackedKeyword.findMany({
      where: {
        appId: id,
        replacedFromId: { not: null },
        ...(territoryFilter ? { territory: territoryFilter.toUpperCase() } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        replacedFrom: {
          include: {
            signals: {
              // Last signal BEFORE the swap — gives the user a sense of
              // what they retired. The new keyword's createdAt bounds
              // "before" for us.
              orderBy: { date: "desc" },
              take: 1,
              select: {
                date: true,
                appStoreRank: true,
                score: true,
                bucket: true,
              },
            },
          },
        },
        signals: {
          orderBy: { date: "desc" },
          take: 1,
          select: {
            date: true,
            appStoreRank: true,
            score: true,
            bucket: true,
          },
        },
      },
    });

    return NextResponse.json({
      swaps: adopted.map((k) => {
        const old = k.replacedFrom;
        const oldLatest = old?.signals[0] ?? null;
        const newLatest = k.signals[0] ?? null;
        return {
          id: k.id,
          date: k.createdAt.toISOString(),
          territory: k.territory,
          tags: k.tags,
          notes: k.notes,
          newKeyword: {
            id: k.id,
            keyword: k.keyword,
            rank: newLatest?.appStoreRank ?? null,
            score: newLatest?.score != null ? Number(newLatest.score) : null,
            bucket: newLatest?.bucket ?? null,
          },
          oldKeyword: old
            ? {
                id: old.id,
                keyword: old.keyword,
                rank: oldLatest?.appStoreRank ?? null,
                score: oldLatest?.score != null ? Number(oldLatest.score) : null,
                bucket: oldLatest?.bucket ?? null,
                replacedAt: old.replacedAt?.toISOString() ?? null,
              }
            : null,
        };
      }),
    });
  });
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
