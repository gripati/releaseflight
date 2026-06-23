/**
 * GET /api/v1/apps/[id]/aso/dashboard?range=30d
 *
 * Single-call data source for the Overview/Pulse dashboard. The projection
 * itself lives in @/lib/asoDashboard so server components (Pulse) can call it
 * in-process; this route is the thin HTTP wrapper the Overview client uses for
 * its range-switch refetches.
 *
 * Window options: 7d / 30d / 90d / 1y. Defaults to 30d.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import { loadAsoDashboard, normaliseRange } from "@/lib/asoDashboard";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const range = normaliseRange(new URL(req.url).searchParams.get("range"));
  return withTenantContext(async () => NextResponse.json(await loadAsoDashboard(id, range)));
});
