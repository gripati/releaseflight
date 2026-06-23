/**
 * GET  /api/v1/apps/[id]/aso/daily-check?date=YYYY-MM-DD
 *   Read the stored AsoDailyCheck for the app + date (defaults to today
 *   in UTC). Returns the metric snapshot, deltas, analyst report, and
 *   all notifications attached to the day.
 *
 * POST /api/v1/apps/[id]/aso/daily-check
 *   Body: { date?: "YYYY-MM-DD", recentChanges?: string, withAnalyst?: boolean }
 *   Triggers the daily-check pipeline synchronously for the chosen
 *   date. Idempotent — re-running the same date upserts notifications
 *   without re-creating reads.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { runAndPersistDailyCheck } from "@/lib/asoDailyCheck";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TriggerBody = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  recentChanges: z.string().trim().max(2000).optional(),
  /** Skip the AI analyst (saves money on test runs / quick re-checks). */
  withAnalyst: z.boolean().optional(),
});

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const dateParam =
    url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    throw new ValidationError("date must be YYYY-MM-DD");
  }

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const check = await prisma.asoDailyCheck.findUnique({
      where: { appId_date: { appId: id, date: new Date(dateParam) } },
    });

    const notifications = await prisma.asoNotification.findMany({
      where: { appId: id, date: new Date(dateParam) },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    });

    return NextResponse.json({
      date: dateParam,
      check: check
        ? {
            id: check.id,
            status: check.status,
            metricsSnapshot: check.metricsSnapshot,
            keywordDeltas: check.keywordDeltas,
            competitorMoves: check.competitorMoves,
            alarmsTriggered: check.alarmsTriggered,
            analystReport: check.analystReport,
            reviewedAt: check.reviewedAt?.toISOString() ?? null,
            createdAt: check.createdAt.toISOString(),
            updatedAt: check.updatedAt.toISOString(),
          }
        : null,
      notifications: notifications.map((n) => ({
        id: n.id,
        severity: n.severity,
        title: n.title,
        message: n.message,
        payload: n.payload,
        trackedKeywordId: n.trackedKeywordId,
        competitorId: n.competitorId,
        agentInterpretation: n.agentInterpretation,
        agentProbableCause: n.agentProbableCause,
        agentNextAction: n.agentNextAction,
        agentConfidence: n.agentConfidence,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  });
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = TriggerBody.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundError("App not found");

    const result = await runAndPersistDailyCheck({
      tenantId: ctx.tenant!.id,
      appId: id,
      date: body.date,
      recentChanges: body.recentChanges,
      withAnalyst: body.withAnalyst,
      triggeredById: ctx.user.id,
    });

    await recordAudit({
      action: "aso.dailyCheck.run",
      target: `app:${id}`,
      outcome: "SUCCESS",
      appId: id,
      diff: {
        date: result.date,
        severity: result.overallSeverity,
        notifications: result.notificationsCreated,
      },
    });

    return NextResponse.json({
      ok: true,
      checkId: result.checkId,
      date: result.date,
      status: result.status,
      overallSeverity: result.overallSeverity,
      counts: result.counts,
      notificationsCreated: result.notificationsCreated,
      analystVerdict: result.analystReport?.overallVerdict ?? null,
    });
  });
});
