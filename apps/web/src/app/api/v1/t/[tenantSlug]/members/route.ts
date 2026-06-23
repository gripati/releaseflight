/**
 * Directly provision a workspace member (no email invitation).
 *
 * An OWNER/ADMIN supplies the new member's email, display name, an initial
 * password, the role, and the set of apps they may access (allowedAppIds —
 * empty = every app). The account is created with `mustChangePassword=true`
 * so the person is forced to set their own password on first sign-in.
 *
 * If a user with that email already exists, they are simply added to the
 * workspace with the chosen role + app scope — their password is left
 * untouched and the first-login change is NOT forced.
 */
import { NextResponse, type NextRequest } from "next/server";
import argon2 from "argon2";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@marquee/core";
import { prismaUnscoped, recordAudit, tenantStorage } from "@marquee/db";
import { CreateMemberRequest } from "@marquee/api-contracts";
import { withApiErrors } from "@/lib/responses";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { requireRole } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { withSeatGuard } from "@/lib/seats";

interface RouteContext {
  params: Promise<{ tenantSlug: string }>;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const { tenantSlug } = await context.params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) throw new NotFoundError("Workspace not found");
  requireRole(tenant.role, "ADMIN");

  const body = CreateMemberRequest.parse(await req.json());
  const email = body.email.toLowerCase();

  // Only an OWNER may grant the OWNER role (mirrors role-change PATCH).
  if (body.role === "OWNER" && tenant.role !== "OWNER") {
    throw new ForbiddenError("Only an OWNER can create a new OWNER");
  }

  // Every selected app must belong to this workspace. Bypass-RLS lookup with an
  // explicit tenantId so the admin's own app scope can't hide valid targets.
  if (body.allowedAppIds.length > 0) {
    const valid = await prismaUnscoped.app.count({
      where: { tenantId: tenant.id, id: { in: body.allowedAppIds } },
    });
    if (valid !== new Set(body.allowedAppIds).size) {
      throw new ValidationError("One or more selected apps do not belong to this workspace");
    }
  }

  // Legacy hosted-SaaS cap — per-tenant rows vs Tenant.maxMembers. Only fires for
  // deployedAs=SAAS; the Polar per-seat cap (withSeatGuard below) governs the
  // self-host path and is a no-op here, so the two never double-count.
  const plan = await prismaUnscoped.tenant.findUnique({
    where: { id: tenant.id },
    select: { deployedAs: true, maxMembers: true },
  });
  if (plan?.deployedAs === "SAAS") {
    const memberCount = await prismaUnscoped.tenantMember.count({
      where: { tenantId: tenant.id },
    });
    if (memberCount >= plan.maxMembers) {
      throw new ConflictError(
        `Seat limit reached (${plan.maxMembers.toString()}). Upgrade your plan or remove a member first.`,
      );
    }
  }

  const existing = await prismaUnscoped.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    const alreadyMember = await prismaUnscoped.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: tenant.id, userId: existing.id } },
    });
    if (alreadyMember) {
      throw new ConflictError("That user is already a member of this workspace");
    }
  }

  // Hash the initial password OUTSIDE the seat transaction — argon2 (~100ms) must
  // not hold a SERIALIZABLE tx open and widen the seat-count race window.
  let passwordHash: string | null = null;
  if (!existing) {
    if (!body.password) {
      throw new ValidationError("A password is required to create a new user");
    }
    passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 4,
    });
  }

  // Member-seat gate + writes, ATOMIC: the instance-wide billable-user count and
  // the create run in one serializable tx so two concurrent "last seat" adds
  // can't both win. No-op unless a Polar subscription has provisioned a cap, and
  // free when this user already holds a billable seat in another workspace.
  let userId = existing?.id ?? "";
  const createdNewUser = !existing;
  await withSeatGuard({ userId: existing?.id ?? null, role: body.role }, async (tx) => {
    if (!existing) {
      const user = await tx.user.create({
        data: {
          email,
          displayName: body.displayName,
          passwordHash: passwordHash!,
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
          mustChangePassword: true,
          defaultTenantId: tenant.id,
        },
        select: { id: true },
      });
      userId = user.id;
    }
    await tx.tenantMember.create({
      data: {
        tenantId: tenant.id,
        userId,
        role: body.role,
        allowedAppIds: body.allowedAppIds,
        invitedById: session.user.id,
      },
    });
  });

  await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      await recordAudit({
        action: "member.create",
        target: `member:${userId}`,
        outcome: "SUCCESS",
        diff: { email, role: body.role, allowedAppIds: body.allowedAppIds, createdNewUser },
      });
    },
  );

  return NextResponse.json({ ok: true, userId, role: body.role, createdNewUser }, { status: 201 });
});
