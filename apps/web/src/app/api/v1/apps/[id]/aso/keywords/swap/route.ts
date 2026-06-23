/**
 * POST /api/v1/apps/[id]/aso/keywords/swap
 *
 * Adopt an Astro suggestion by swapping it IN for an existing tracked
 * keyword. The transaction:
 *
 *   1. The old TrackedKeyword gets archived (status=ARCHIVED,
 *      replacedAt=now) — its historical signals stay queryable so the
 *      adopted-vs-default performance view can compare them.
 *   2. A new TrackedKeyword is created with:
 *        • tags: ["adopted"]
 *        • replacedFromId pointing at the archived predecessor
 *        • source: AI_SUGGESTED
 *   3. (Best-effort) The AppLocalization.keywords field for the
 *      matching territory's locale is updated — the old token is
 *      replaced inline with the new one so the next metadata.push
 *      ships the swap. If the user wants to push immediately, that's
 *      a separate action.
 *
 * Returns the new TrackedKeyword id so the UI can navigate to it or
 * highlight it as the "fresh adoption" in the keyword list.
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

const SwapRequest = z.object({
  /** Existing TrackedKeyword to retire. Required — the swap is a
   *  1-for-1 replacement; if you just want to track something new,
   *  use POST /aso/keywords directly. */
  oldTrackedKeywordId: z.string().uuid(),
  /** Token to adopt — usually came from the Astro autopilot UI. */
  newKeyword: z.string().trim().min(1).max(80),
  /** Optional notes describing why the swap happened (e.g. "AI rec
   *  93% relevance, popularity 65, difficulty 28"). */
  notes: z.string().trim().max(500).optional(),
});

export const dynamic = "force-dynamic";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = SwapRequest.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const old = await prisma.trackedKeyword.findFirst({
      where: { id: body.oldTrackedKeywordId, appId: id },
    });
    if (!old) throw new NotFoundError("Old tracked keyword not found");
    if (old.status === "ARCHIVED") {
      throw new ValidationError("Old keyword is already archived");
    }

    // Block the swap when the destination keyword is already tracked
    // for the same territory — that would create a unique-key
    // collision and confuse the lineage (which one is canonical?).
    const collision = await prisma.trackedKeyword.findUnique({
      where: {
        appId_keyword_territory: {
          appId: id,
          keyword: body.newKeyword,
          territory: old.territory,
        },
      },
    });
    if (collision && collision.status !== "ARCHIVED") {
      throw new ValidationError(
        `"${body.newKeyword}" already tracked for ${old.territory}`,
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Archive the old keyword (keep history for adopted-vs-default
      //    performance comparison).
      const archived = await tx.trackedKeyword.update({
        where: { id: old.id },
        data: {
          status: "ARCHIVED",
          replacedAt: new Date(),
        },
      });

      // 2. Create the new adoption. If a collision row exists (e.g.
      //    archived from a previous run) we revive it instead of
      //    creating — Prisma's @@unique would otherwise reject.
      const newTags = Array.from(new Set([...(collision?.tags ?? []), "adopted"]));
      const created = collision
        ? await tx.trackedKeyword.update({
            where: { id: collision.id },
            data: {
              status: "ACTIVE",
              source: "AI_SUGGESTED",
              tags: { set: newTags },
              replacedFromId: archived.id,
              replacedAt: null,
              notes: body.notes ?? collision.notes,
            },
          })
        : await tx.trackedKeyword.create({
            data: {
              tenantId: ctx.tenant!.id,
              appId: id,
              keyword: body.newKeyword,
              territory: old.territory,
              source: "AI_SUGGESTED",
              tags: ["adopted"],
              notes: body.notes,
              replacedFromId: archived.id,
              createdById: ctx.user.id,
            },
          });

      return { archived, created };
    });

    // 3. Best-effort metadata sync — swap the token inside the
    //    AppLocalization.keywords field for the locale that matches
    //    the old keyword's territory. Failures here are non-fatal:
    //    the swap stays valid even if metadata write is rejected
    //    (dirty edit conflict, etc).
    let metadataPatched = false;
    try {
      const locs = await prisma.appLocalization.findMany({
        where: { appId: id },
        select: { id: true, locale: true, keywords: true, dirty: true },
      });
      const oldTokenLc = old.keyword.toLowerCase();
      for (const loc of locs) {
        if (!loc.keywords) continue;
        const tokens = loc.keywords.split(",").map((t) => t.trim());
        const idx = tokens.findIndex((t) => t.toLowerCase() === oldTokenLc);
        if (idx === -1) continue;
        tokens[idx] = body.newKeyword;
        const nextField = tokens.filter((t) => t.length > 0).join(",");
        // 100-char cap on iOS keywords field — if the swap pushes us
        // over, skip the inline patch and let the user resolve in the
        // metadata workbench. Visible swap still happens in TrackedKeyword.
        if (nextField.length > 100) continue;
        await prisma.appLocalization.update({
          where: { id: loc.id },
          data: { keywords: nextField, dirty: true },
        });
        metadataPatched = true;
      }
    } catch {
      /* tolerate metadata patch failure — TrackedKeyword swap is the
         source of truth */
    }

    await recordAudit({
      action: "aso.keyword.swap",
      target: `keyword:${result.created.id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: {
        oldKeyword: old.keyword,
        newKeyword: result.created.keyword,
        territory: old.territory,
        metadataPatched,
      },
    });

    return NextResponse.json({
      ok: true,
      newTrackedKeywordId: result.created.id,
      archivedTrackedKeywordId: result.archived.id,
      metadataPatched,
    });
  });
});
