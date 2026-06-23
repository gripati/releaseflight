/**
 * POST /api/v1/jobs/[id]/cancel
 *
 * Mark an in-flight job as CANCELLED. Cooperative — the worker (if
 * actively processing) notices on its next progress publish and
 * unwinds cleanly via {@link JobCancelledError}. BullMQ entries are
 * removed so the job won't be retried.
 *
 * Auth: caller must be a member of the job's tenant with EDITOR+ role.
 *
 * Response shape:
 *   • 200 — `{ cancelled: true, status: "CANCELLED" }` when this call
 *     transitioned the job. Idempotent on a cancel race.
 *   • 200 — `{ cancelled: false, status: "<existing>" }` when the job
 *     was already terminal (COMPLETED / FAILED / CANCELLED). Same code
 *     so the UI can show a friendly "already finished" message
 *     instead of an error toast.
 *   • 404 — job not found.
 *   • 403 — caller not a member of the job's tenant.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, NotFoundError } from "@marquee/core";
import { prismaUnscoped } from "@marquee/db";
import { cancelJob } from "@marquee/jobs";
import { withApiErrors } from "@/lib/responses";
import { getSessionFromCookie } from "@/lib/session";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { assertAppAccess } from "@/lib/auth-helpers";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const session = await getSessionFromCookie();
  if (!session) throw new ForbiddenError("Authentication required");
  const { id } = await context.params;

  // Load the job WITHOUT a tenant filter so we can give a clear 404
  // before authorising. Membership check follows.
  const job = await prismaUnscoped.job.findUnique({
    where: { id },
    select: { id: true, tenantId: true, appId: true, kind: true, status: true },
  });
  if (!job) throw new NotFoundError("Job not found");

  const member = await prismaUnscoped.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId: job.tenantId, userId: session.userId } },
    select: { role: true, allowedAppIds: true },
  });
  if (!member) throw new ForbiddenError("Not a member of this workspace");
  // Per-member app scoping (Job is not app-scoped at the RLS layer).
  if (job.appId) assertAppAccess(member.allowedAppIds, job.appId);
  // EDITOR or OWNER may cancel — VIEWER cannot mutate background work.
  if (member.role !== "OWNER" && member.role !== "EDITOR") {
    throw new ForbiddenError("Cancelling jobs requires editor permissions");
  }

  const result = await cancelJob(id, {
    reason: "Cancelled by user from the Jobs page",
    userId: session.userId,
  });

  return NextResponse.json(result);
});
