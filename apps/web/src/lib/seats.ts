/**
 * Member-seat enforcement for Polar per-seat licensing.
 *
 * A "billable seat" = one DISTINCT active `User` holding ≥1 `TenantMember` with a
 * billable role (OWNER/ADMIN/MAINTAINER/EDITOR), counted INSTANCE-WIDE across all
 * tenants. VIEWER is free (read-only). One person in three workspaces = ONE seat,
 * which is what defeats "spin up extra workspaces / invite everyone" abuse.
 *
 * The cap (`memberSeats`) comes from the signed license token (Polar quantity →
 * license-server → token entitlements). When no positive cap is present
 * (`seatsEnforced === false` — dev, non-sealed self-host, or pre-Polar) every
 * gate here is a NO-OP, so existing installs are completely unaffected until a
 * subscription actually provisions a seat count.
 *
 * TenantMember/User are touched via `prismaUnscoped` with explicit predicates —
 * the same sanctioned cross-tenant-accounting pattern the member routes already
 * use (TenantMember is intentionally not under RLS; see rls.sql).
 */
import { Prisma, TenantRole } from "@prisma/client";
import { prismaUnscoped } from "@marquee/db";
import { BillingSuspendedError, SeatLimitReachedError } from "@marquee/core";
import { getEntitlements } from "@marquee/license";

export const BILLABLE_ROLES: TenantRole[] = [
  TenantRole.OWNER,
  TenantRole.ADMIN,
  TenantRole.MAINTAINER,
  TenantRole.EDITOR,
];

export function isBillableRole(role: TenantRole): boolean {
  return BILLABLE_ROLES.includes(role);
}

/** Distinct active users that currently occupy a billable seat, instance-wide. */
export function countBillableSeats(tx: Prisma.TransactionClient): Promise<number> {
  return tx.user.count({
    where: { status: "ACTIVE", memberships: { some: { role: { in: BILLABLE_ROLES } } } },
  });
}

/**
 * Does this user ALREADY occupy a billable seat (so re-using them is free)? Must
 * use the SAME predicate as countBillableSeats — active user + billable role —
 * or a disabled user with a billable membership would read as "free" while not
 * being counted in `used`, letting an add slip past the cap.
 */
async function userAlreadyBillable(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const c = await tx.tenantMember.count({
    where: { userId, role: { in: BILLABLE_ROLES }, user: { status: "ACTIVE" } },
  });
  return c > 0;
}

/** Seat usage for the Settings → Billing page / banner. seats=null ⇒ unlimited. */
export async function getSeatUsage(): Promise<{ used: number; seats: number | null; billingState: string }> {
  const ent = getEntitlements();
  const used = await countBillableSeats(prismaUnscoped);
  return { used, seats: ent.memberSeats, billingState: ent.billingState };
}

/**
 * Whether to surface the Seats page (which also manages members) and its nav entry.
 * A SOLO licence (cap of exactly 1) has no team to manage, so the page is hidden.
 * Multi-seat (agency) licences AND unlimited/unenforced installs (dev, non-Polar
 * self-host — memberSeats === null) show it. Hidden ONLY when the cap is exactly 1.
 */
export function seatsPageEnabled(): boolean {
  const seats = getEntitlements().memberSeats;
  return seats === null || seats > 1;
}

/**
 * Run a membership write that may consume a billable seat, atomically gated by
 * the seat cap. The count + the write happen in ONE serializable transaction so
 * two concurrent "add the last seat" requests can't both succeed (TOCTOU). On a
 * serialization conflict (40001 / P2034) we retry, mirroring `withOwnerGuard`.
 *
 * The gate is skipped (no seat consumed) when the assigned role is non-billable,
 * when seat enforcement is off, or when the target user ALREADY holds a billable
 * seat elsewhere (so adding them to another workspace is free).
 */
export async function withSeatGuard(
  opts: { userId: string | null; role: TenantRole },
  write: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  const ent = getEntitlements();
  const consumesSeat = isBillableRole(opts.role) && ent.seatsEnforced;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await prismaUnscoped.$transaction(
        async (tx) => {
          if (consumesSeat) {
            const free = opts.userId !== null && (await userAlreadyBillable(tx, opts.userId));
            if (!free) {
              const used = await countBillableSeats(tx);
              // ent.memberSeats is a positive int whenever seatsEnforced is true.
              if (used + 1 > (ent.memberSeats ?? Infinity)) {
                throw new SeatLimitReachedError(used, ent.memberSeats ?? 0, ent.manageBillingUrl);
              }
            }
          }
          await write(tx);
        },
        consumesSeat ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined,
      );
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === "P2034" || code === "40001") && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

/**
 * Read-only freeze gate for MUTATING requests. Throws 402 BillingSuspendedError
 * when the subscription is on hold (past the grace window / suspended / revoked).
 * No-op for every other state and when enforcement is off, so it is invisible
 * until Polar actually suspends an instance.
 */
export function assertBillingActive(): void {
  const ent = getEntitlements();
  if (ent.billingState === "suspended") {
    throw new BillingSuspendedError(ent.manageBillingUrl);
  }
}
