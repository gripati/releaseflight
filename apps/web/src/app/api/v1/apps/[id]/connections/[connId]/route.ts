import { NextResponse, type NextRequest } from "next/server";
import { UpdateConnectionRequest } from "@marquee/api-contracts";
import { prisma, prismaUnscoped } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { connectionToDto } from "../route";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; connId: string }>;
}

/**
 * Metadata-only update of an existing connection. Does NOT touch the stored
 * secret, so an already-connected Firebase/Git/keystore stays connected — the
 * user can adjust app ids / branch / tester groups without re-uploading the
 * service account. This is what keeps "edit" from forcing a full reconnect.
 */
export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id: appId, connId } = await context.params;
  const body = UpdateConnectionRequest.parse(await req.json());

  return withTenantContext(async () => {
    const existing = await prisma.appConnection.findFirst({ where: { id: connId, appId } });
    if (!existing) throw new NotFoundError("Connection not found");

    const meta = { ...((existing.metadata as Record<string, unknown> | null) ?? {}) };
    if (body.repoUrl !== undefined) meta.repoUrl = body.repoUrl;
    if (body.branch !== undefined) meta.branch = body.branch;
    if (body.iosAppId !== undefined) meta.iosAppId = body.iosAppId || null;
    if (body.androidAppId !== undefined) meta.androidAppId = body.androidAppId || null;
    if (body.testerGroups !== undefined) meta.testerGroups = body.testerGroups;

    const updated = await prisma.appConnection.update({
      where: { id: connId },
      data: { metadata: meta as never },
    });
    return NextResponse.json({ connection: connectionToDto(updated) });
  });
});

/** Disconnects a service: deletes the stored secret and the connection row. */
export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id: appId, connId } = await context.params;
  const sp = createSecretProvider();

  return withTenantContext(async () => {
    const existing = await prisma.appConnection.findFirst({ where: { id: connId, appId } });
    if (!existing) throw new NotFoundError("Connection not found");
    await sp.delete(existing.secretRef).catch(() => undefined);
    await prismaUnscoped.appConnection.delete({ where: { id: connId } });
    return NextResponse.json({ ok: true });
  });
});
