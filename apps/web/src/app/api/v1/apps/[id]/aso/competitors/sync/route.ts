/**
 * POST /api/v1/apps/[id]/aso/competitors/sync
 *
 * Manually trigger an `aso.competitor-sync` BullMQ job for one app.
 * The same job runs nightly at 03:00 UTC; this endpoint exists for
 * two operator-facing flows:
 *
 *   • "Sync now" on a single competitor card → body: { competitorId }
 *   • "Sync all competitors" on the panel header → body: {} (all
 *     monitored competitors for the app)
 *
 * The endpoint enqueues + returns immediately. Operator-facing progress
 * lands as AsoNotification rows once the worker finishes (typically
 * 8-30 seconds depending on territory count). The response carries the
 * BullMQ job id so the UI can optionally poll `/jobs/:id` for status.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { queues } from "@marquee/jobs";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SyncBody = z.object({
  /** Restrict the run to one competitor by id. Omit to sync every
   *  monitored competitor on this app. */
  competitorId: z.string().uuid().optional(),
  /** Force-include `monitor=false` competitors. Default true when
   *  competitorId is set (per-card "sync now" should always work
   *  even on paused rows), false otherwise. */
  includeUnmonitored: z.boolean().optional(),
});

export const dynamic = "force-dynamic";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId } = await context.params;
  const body = SyncBody.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id: appId },
      select: { id: true, tenantId: true },
    });
    if (!app) throw new NotFoundError("App not found");

    // When the operator scopes the run to a specific competitor, make
    // sure it belongs to this app — otherwise a paste of a competitor
    // id from another app would cross-tenant leak (RLS would block the
    // actual fetch but the 404 surface here is clearer).
    if (body.competitorId) {
      const exists = await prisma.competitor.findFirst({
        where: { id: body.competitorId, appId },
        select: { id: true },
      });
      if (!exists) {
        throw new ValidationError("Competitor not found on this app");
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    // Pre-built BullMQ jobId for idempotency: when the operator double-
    // clicks within the same minute we return the existing job rather
    // than queueing two iTunes Lookup fans.
    const jobIdScope = body.competitorId ?? "all";
    const jobId = `competitor-sync-manual:${appId}:${jobIdScope}:${date}:${Date.now().toString()}`;

    const job = await queues["aso.competitor-sync"].add(
      jobId,
      {
        tenantId: app.tenantId,
        appId,
        date,
        userId: ctx.user.id,
        // Per-card "Sync now" always force-runs, even on paused rows;
        // the panel-wide "Sync all" honours the monitor flag.
        includeUnmonitored:
          body.includeUnmonitored ??
          (body.competitorId !== undefined ? true : false),
        ...(body.competitorId
          ? { competitorIds: [body.competitorId] }
          : {}),
      },
      { jobId },
    );

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      scope: body.competitorId ? "single" : "all",
    });
  });
});
