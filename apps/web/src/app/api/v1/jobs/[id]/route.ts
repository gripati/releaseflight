/**
 * GET /api/v1/jobs/[id]
 *
 * Lightweight JSON poll for a job's status + progress. Use the SSE
 * stream sibling for live updates; this route is intended for client
 * code that wants a single snapshot or has no Server-Sent-Events
 * support (older browsers, certain proxies, retries after disconnect).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, NotFoundError } from "@marquee/core";
import { prismaUnscoped } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { getSessionFromCookie } from "@/lib/session";
import { assertAppAccess } from "@/lib/auth-helpers";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  const session = await getSessionFromCookie();
  if (!session) throw new ForbiddenError("Authentication required");
  const { id } = await context.params;

  const job = await prismaUnscoped.job.findUnique({ where: { id } });
  if (!job) throw new NotFoundError("Job not found");

  const membership = await prismaUnscoped.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId: job.tenantId, userId: session.userId } },
  });
  if (!membership) throw new ForbiddenError("Not a member of this workspace");
  // Job is tenant-isolated but NOT app-scoped at the RLS layer (and this route
  // uses prismaUnscoped), so enforce per-member app scoping for app-bound jobs.
  if (job.appId) assertAppAccess(membership.allowedAppIds, job.appId);

  return NextResponse.json({
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: {
      current: job.progressCurrent,
      total: job.progressTotal,
      step: job.progressStep,
    },
    appId: job.appId,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  });
});
