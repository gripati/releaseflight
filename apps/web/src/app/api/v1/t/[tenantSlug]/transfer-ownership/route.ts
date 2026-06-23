/**
 * Hand off the OWNER role to another member.
 *
 * Only a current OWNER may call this. The target is promoted to OWNER and the
 * caller is demoted to ADMIN in a single transaction — the workspace therefore
 * always has at least one OWNER throughout (we promote before we demote), so
 * the last-OWNER invariant can never be violated mid-flight. This is the
 * endpoint the member role-change route points callers to when an OWNER tries
 * to demote themselves directly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prismaUnscoped, recordAudit, tenantStorage } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { requireRole } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { withSeatGuard } from "@/lib/seats";

interface RouteContext { params: Promise<{ tenantSlug: string }> }

const Body = z.object({ userId: z.string().uuid() });

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const { tenantSlug } = await context.params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) throw new NotFoundError("Workspace not found");
  // Only an OWNER can transfer ownership.
  requireRole(tenant.role, "OWNER");

  const { userId } = Body.parse(await req.json());
  if (userId === session.user.id) {
    throw new ValidationError("You already own this workspace");
  }

  return tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const target = await prismaUnscoped.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId } },
      });
      if (!target) throw new NotFoundError("Member not found");
      if (target.role === "OWNER") {
        throw new ValidationError("That member is already an OWNER");
      }

      // Promoting a VIEWER (non-billable) to OWNER consumes a member seat, so
      // gate it — otherwise transfer-ownership would be a seat-cap bypass. The
      // caller's OWNER→ADMIN demotion stays billable (no net change), and the
      // gate is free when the target already holds a billable seat. withSeatGuard
      // runs both updates in one (serializable, when a seat is consumed) tx,
      // promoting FIRST so the workspace is never left ownerless mid-flight.
      await withSeatGuard({ userId, role: "OWNER" }, async (tx) => {
        await tx.tenantMember.update({
          where: { tenantId_userId: { tenantId: tenant.id, userId } },
          data: { role: "OWNER" },
        });
        await tx.tenantMember.update({
          where: { tenantId_userId: { tenantId: tenant.id, userId: session.user.id } },
          data: { role: "ADMIN" },
        });
      });

      await recordAudit({
        action: "member.transfer-ownership",
        target: `member:${userId}`,
        outcome: "SUCCESS",
        diff: { from: session.user.id, to: userId },
      });

      return NextResponse.json({ ok: true });
    },
  );
});
