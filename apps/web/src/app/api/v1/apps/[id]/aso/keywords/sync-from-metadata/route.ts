/**
 * POST /api/v1/apps/[id]/aso/keywords/sync-from-metadata
 *
 * Imports every comma-separated token in each locale's `keywords` field
 * into the watchlist as a TrackedKeyword (source = APP_METADATA).
 * Idempotent — re-runs only add new tokens, never duplicates.
 *
 * Body (optional): { locales?: string[] } — restrict to these locales.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { syncKeywordsFromMetadata } from "@/lib/keywordsFromMetadata";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  locales: z.array(z.string().min(2).max(20)).max(80).optional(),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const summary = await syncKeywordsFromMetadata({
      tenantId: ctx.tenant!.id,
      appId: id,
      userId: ctx.user.id,
      ...(body.locales ? { locales: body.locales } : {}),
    });

    await recordAudit({
      action: "aso.keyword.import-from-metadata",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: {
        importedCount: summary.importedCount,
        skippedExisting: summary.skippedExisting,
        perLocale: summary.perLocale,
      },
    });

    return NextResponse.json(summary);
  });
});
