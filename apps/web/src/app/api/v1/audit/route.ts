import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import { assertAppAccess } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest) => {
  const ctx = await requireTenant();
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
  const cursor = url.searchParams.get("cursor");
  const action = url.searchParams.get("action");
  const outcome = url.searchParams.get("outcome");
  const userId = url.searchParams.get("userId");
  const appId = url.searchParams.get("appId");

  // AuditEvent is tenant-isolated but NOT app-scoped at the RLS layer (the
  // app.allowed_app_ids GUC does not filter it), so per-member app scoping must
  // be enforced here in code. A scoped member may only filter to an app they can
  // access; the unfiltered listing is narrowed to their apps (+ tenant-level,
  // appId-null events). An empty allowedAppIds means unrestricted.
  if (appId) assertAppAccess(ctx.allowedAppIds, appId);
  const scopeWhere =
    ctx.allowedAppIds.length > 0
      ? { OR: [{ appId: null }, { appId: { in: ctx.allowedAppIds } }] }
      : {};

  return withTenantContext(async () => {
    const where = {
      ...(action ? { action } : {}),
      ...(outcome ? { outcome: outcome as "SUCCESS" | "FAILURE" | "PARTIAL" } : {}),
      ...(userId ? { userId } : {}),
      ...(appId ? { appId } : scopeWhere),
    };
    const events = await prisma.auditEvent.findMany({
      where,
      take: limit + 1,
      orderBy: { createdAt: "desc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        user: { select: { displayName: true, email: true } },
        app: { select: { appName: true, bundleId: true, platform: true } },
      },
    });
    const hasNext = events.length > limit;
    const data = hasNext ? events.slice(0, limit) : events;
    return NextResponse.json({
      events: data.map((e) => ({
        id: e.id,
        action: e.action,
        target: e.target,
        outcome: e.outcome,
        errorCode: e.errorCode,
        diff: e.diff,
        createdAt: e.createdAt.toISOString(),
        user: e.user,
        app: e.app,
        ipAddress: e.ipAddress,
        requestId: e.requestId,
      })),
      nextCursor: hasNext ? data[data.length - 1]?.id : null,
    });
  });
});
