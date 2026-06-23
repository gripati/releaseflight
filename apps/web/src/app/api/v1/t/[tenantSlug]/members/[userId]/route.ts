import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@marquee/core";
import { TenantRole } from "@marquee/api-contracts";
import { prisma, prismaUnscoped, recordAudit, tenantStorage } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { requireRole } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { isBillableRole, withSeatGuard } from "@/lib/seats";

interface RouteContext { params: Promise<{ tenantSlug: string; userId: string }> }

const PatchMember = z
  .object({
    role: TenantRole.optional(),
    allowedAppIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .refine((d) => d.role !== undefined || d.allowedAppIds !== undefined, {
    message: "Provide a role and/or allowedAppIds to update",
  });

/**
 * Runs `fn` in a SERIALIZABLE transaction, retrying on Postgres serialization
 * failures. The last-OWNER invariant ("a workspace always keeps ≥1 OWNER") is
 * a read-then-write (count owners → mutate); under READ COMMITTED two
 * concurrent demote/remove requests can each read ownerCount=2 and both
 * proceed, leaving zero owners. SERIALIZABLE turns that race into a detectable
 * conflict (40001 / P2034) so exactly one wins and the loser retries.
 *
 * TenantMember is intentionally NOT under RLS (see rls.sql), so the unscoped
 * client with explicit tenantId predicates is the canonical way to touch it.
 */
async function withOwnerGuard(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await prismaUnscoped.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === "P2034" || code === "40001") && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const { tenantSlug, userId } = await context.params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) throw new NotFoundError("Workspace not found");
  requireRole(tenant.role, "ADMIN");
  const body = PatchMember.parse(await req.json());

  // An OWNER demoting THEMSELVES must hand off via transfer-ownership instead.
  if (
    body.role !== undefined &&
    body.role !== "OWNER" &&
    userId === session.user.id &&
    tenant.role === "OWNER"
  ) {
    throw new ValidationError(
      "Transfer ownership to another member before demoting yourself.",
    );
  }

  // Privilege-escalation guard: only an OWNER may GRANT the OWNER role.
  // Without this an ADMIN (who passes the requireRole(ADMIN) gate) could
  // promote themselves or anyone else to OWNER and seize the workspace.
  if (body.role === "OWNER" && tenant.role !== "OWNER") {
    throw new ForbiddenError("Only an OWNER can grant the OWNER role");
  }

  // Every selected app must belong to this workspace.
  if (body.allowedAppIds && body.allowedAppIds.length > 0) {
    const valid = await prismaUnscoped.app.count({
      where: { tenantId: tenant.id, id: { in: body.allowedAppIds } },
    });
    if (valid !== new Set(body.allowedAppIds).size) {
      throw new ValidationError("One or more selected apps do not belong to this workspace");
    }
  }

  return tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const member = await prisma.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId } },
      });
      if (!member) throw new NotFoundError("Member not found");

      // Only the OWNER can change another OWNER (role or app scope).
      if (member.role === "OWNER" && tenant.role !== "OWNER") {
        throw new ForbiddenError("Only OWNER can change another OWNER");
      }

      const data = {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.allowedAppIds !== undefined ? { allowedAppIds: body.allowedAppIds } : {}),
      };
      const demotingOwner =
        member.role === "OWNER" && body.role !== undefined && body.role !== "OWNER";
      if (demotingOwner) {
        // Count + update atomically so concurrent demotions can't strand the
        // workspace with zero OWNERs (see withOwnerGuard).
        await withOwnerGuard(async (tx) => {
          const ownerCount = await tx.tenantMember.count({
            where: { tenantId: tenant.id, role: "OWNER" },
          });
          if (ownerCount <= 1) {
            throw new ValidationError("Workspace must keep at least one OWNER");
          }
          await tx.tenantMember.update({
            where: { tenantId_userId: { tenantId: tenant.id, userId } },
            data,
          });
        });
      } else if (body.role !== undefined && isBillableRole(body.role) && !isBillableRole(member.role)) {
        // VIEWER → billable role consumes a member seat. Gate it atomically
        // (instance-wide count + update in one serializable tx) so a promotion
        // can't sneak past the cap — closes the "role laundering" bypass.
        await withSeatGuard({ userId, role: body.role }, async (tx) => {
          await tx.tenantMember.update({
            where: { tenantId_userId: { tenantId: tenant.id, userId } },
            data,
          });
        });
      } else {
        await prisma.tenantMember.update({
          where: { tenantId_userId: { tenantId: tenant.id, userId } },
          data,
        });
      }
      await recordAudit({
        action: "member.update",
        target: `member:${userId}`,
        outcome: "SUCCESS",
        diff: {
          ...(body.role !== undefined ? { role: { from: member.role, to: body.role } } : {}),
          ...(body.allowedAppIds !== undefined
            ? { allowedAppIds: { from: member.allowedAppIds, to: body.allowedAppIds } }
            : {}),
        },
      });
      return NextResponse.json({ ok: true, role: body.role ?? member.role });
    },
  );
});

export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const { tenantSlug, userId } = await context.params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) throw new NotFoundError("Workspace not found");
  // Members can remove themselves (leave); admins/owners can remove anyone else.
  if (userId !== session.user.id) {
    requireRole(tenant.role, "ADMIN");
  }

  return tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const member = await prisma.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId } },
      });
      if (!member) throw new NotFoundError("Member not found");
      // Only an OWNER may remove another OWNER. Without this an ADMIN (who
      // passes the requireRole(ADMIN) gate) could evict an OWNER — the
      // role-change PATCH already enforces this same rule, so DELETE matches.
      if (member.role === "OWNER" && userId !== session.user.id && tenant.role !== "OWNER") {
        throw new ForbiddenError("Only an OWNER can remove another OWNER");
      }
      if (member.role === "OWNER") {
        // Count + delete atomically so concurrent removals can't strand the
        // workspace with zero OWNERs (see withOwnerGuard).
        await withOwnerGuard(async (tx) => {
          const ownerCount = await tx.tenantMember.count({
            where: { tenantId: tenant.id, role: "OWNER" },
          });
          if (ownerCount <= 1) {
            throw new ValidationError("Cannot remove the last OWNER");
          }
          await tx.tenantMember.delete({
            where: { tenantId_userId: { tenantId: tenant.id, userId } },
          });
        });
      } else {
        await prisma.tenantMember.delete({
          where: { tenantId_userId: { tenantId: tenant.id, userId } },
        });
      }
      // If the user removed themselves, also invalidate their active session
      if (userId === session.user.id) {
        await prismaUnscoped.session.deleteMany({ where: { userId, activeTenantId: tenant.id } });
      }
      await recordAudit({
        action: "member.remove",
        target: `member:${userId}`,
        outcome: "SUCCESS",
        diff: { role: member.role, removedSelf: userId === session.user.id },
      });
      return new NextResponse(null, { status: 204 });
    },
  );
});
