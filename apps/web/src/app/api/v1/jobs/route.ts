/**
 * GET /api/v1/jobs
 *
 * Tenant-scoped list of recent jobs. Lightweight DTO — no full
 * `result` / `error` payload (those can be huge for Astro analyze
 * runs). The Jobs page polls this every few seconds to refresh the
 * live table without forcing the user to hit reload.
 *
 * Query params:
 *   • `limit`   (optional, 1..200, default 50)
 *   • `status`  (optional, comma-separated: QUEUED,RUNNING,COMPLETED,
 *                FAILED,CANCELLED,WAITING_RETRY) — when set, only jobs
 *                in those states are returned.
 *   • `kind`    (optional) — exact match on `Job.kind`.
 *
 * Returns:
 *   { jobs: JobSummary[], stableUntil: ISO | null }
 *
 *   `stableUntil` is a hint to the client: when no jobs are in flight,
 *   the next poll can wait longer (the client uses this to throttle
 *   from 2s → 10s).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().optional(),
  kind: z.string().optional(),
});

type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "WAITING_RETRY";

const ALL_STATUSES = new Set<JobStatus>([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "WAITING_RETRY",
]);

export const GET = withApiErrors(async (req: NextRequest) => {
  const ctx = await requireTenant();
  const url = new URL(req.url);
  const params = Query.parse({
    limit: url.searchParams.get("limit") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    kind: url.searchParams.get("kind") ?? undefined,
  });

  const statusFilter: JobStatus[] = params.status
    ? params.status
        .split(",")
        .map((s) => s.trim().toUpperCase() as JobStatus)
        .filter((s): s is JobStatus => ALL_STATUSES.has(s))
    : [];

  return withTenantContext(async () => {
    const rows = await prisma.job.findMany({
      where: {
        ...(statusFilter.length > 0 && { status: { in: statusFilter } }),
        ...(params.kind && { kind: params.kind }),
        // Job is tenant-only at the RLS layer, so app-scope per-member here:
        // show app-bound jobs only for in-scope apps (+ tenant-level, null-app jobs).
        ...(ctx.allowedAppIds.length > 0 && {
          OR: [{ appId: null }, { appId: { in: ctx.allowedAppIds } }],
        }),
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
      select: {
        id: true,
        kind: true,
        status: true,
        progressCurrent: true,
        progressTotal: true,
        progressStep: true,
        appId: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    const jobs = rows.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      progress: {
        current: j.progressCurrent,
        total: j.progressTotal,
        step: j.progressStep,
      },
      appId: j.appId,
      createdAt: j.createdAt.toISOString(),
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
    }));

    const anyInflight = jobs.some(
      (j) => j.status === "QUEUED" || j.status === "RUNNING",
    );

    return NextResponse.json({
      jobs,
      // Client can use this to choose poll cadence: short while
      // anything is moving, longer when everything is stable.
      anyInflight,
    });
  });
});
