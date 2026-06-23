/**
 * POST /api/v1/apps/[id]/aso/sync
 *
 * Smart sync. The UI hits this with an empty body and the route
 * figures out everything that should happen right now:
 *
 *   • Catch up Analytics from the last day we have on file
 *     (or 90-day backfill on first connection).
 *   • Refresh keyword signals (iTunes rank + Google Trends) for every
 *     ACTIVE TrackedKeyword.
 *   • Import any new tokens from the per-locale keywords field.
 *
 * All three are idempotent — pressing the button repeatedly is safe.
 * Returns a structured summary so the UI can render a single rich
 * toast instead of three.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { runSmartSync } from "@/lib/smartSync";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;

  return withTenantContext(async () => {
    const summary = await runSmartSync({
      tenantId: ctx.tenant!.id,
      appId: id,
      userId: ctx.user.id,
    });
    return NextResponse.json(summary, { status: 202 });
  });
});
