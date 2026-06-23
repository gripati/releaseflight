import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { NotFoundError, ConflictError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  /** Apple Sales-and-Trends vendor number. Pass empty string to clear. */
  appleVendorNumber: z
    .union([z.string().regex(/^\d{6,12}$/, "6-12 digits"), z.literal("")])
    .optional(),
});

/**
 * GET /api/v1/credentials/:id — single credential (no secret material).
 */
export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  return withTenantContext(async (ctx) => {
    // Defense-in-depth: explicit tenant scoping in addition to RLS.
    const cred = await prisma.credential.findFirst({
      where: { id, tenantId: ctx.tenant!.id },
      include: { _count: { select: { apps: true } } },
    });
    if (!cred) throw new NotFoundError("Credential not found");
    return NextResponse.json({
      credential: {
        id: cred.id,
        kind: cred.kind,
        name: cred.name,
        appleKeyId: cred.appleKeyId,
        appleIssuerId: cred.appleIssuerId,
        googleClientEmail: cred.googleClientEmail,
        googleProjectId: cred.googleProjectId,
        lastTestedAt: cred.lastTestedAt?.toISOString() ?? null,
        lastTestSucceeded: cred.lastTestSucceeded,
        lastTestMessage: cred.lastTestMessage,
        appCount: cred._count.apps,
        createdAt: cred.createdAt.toISOString(),
        rotatedAt: cred.rotatedAt?.toISOString() ?? null,
        isActive: cred.isActive,
      },
    });
  });
});

/**
 * PATCH /api/v1/credentials/:id — rename or activate/deactivate.
 * Does NOT touch secret material; rotation is a separate endpoint.
 */
export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;
  const body = PatchSchema.parse(await req.json());

  return withTenantContext(async () => {
    const exists = await prisma.credential.findFirst({
      where: { id, tenantId: ctx.tenant!.id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError("Credential not found");
    const updated = await prisma.credential.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.appleVendorNumber !== undefined
          ? { appleVendorNumber: body.appleVendorNumber === "" ? null : body.appleVendorNumber }
          : {}),
      },
    });
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      isActive: updated.isActive,
      appleVendorNumber: updated.appleVendorNumber,
    });
  });
});

/**
 * DELETE /api/v1/credentials/:id — hard delete.
 * Refuses if any App still references this credential — fail-loud rather
 * than orphaning App rows.
 */
export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;
  const sp = createSecretProvider();

  return withTenantContext(async () => {
    const cred = await prisma.credential.findFirst({
      where: { id, tenantId: ctx.tenant!.id },
      include: { _count: { select: { apps: true } } },
    });
    if (!cred) throw new NotFoundError("Credential not found");
    if (cred._count.apps > 0) {
      throw new ConflictError(
        `Credential is still connected to ${cred._count.apps.toString()} app(s). Disconnect them first or deactivate the credential.`,
        { appCount: cred._count.apps },
      );
    }

    // Delete the DB row first; if secret-store fails afterwards we accept
    // a dangling encrypted blob (orphan blobs are cheaper than a leaked key
    // referenced by no DB row).
    await prisma.credential.delete({ where: { id } });

    try {
      await sp.delete(cred.secretRef);
    } catch {
      /* best-effort — log only */
    }

    return NextResponse.json({ ok: true });
  });
});
