import { NextResponse, type NextRequest } from "next/server";
import { CreateConnectionRequest, type AppConnectionDto } from "@marquee/api-contracts";
import { prisma, prismaUnscoped } from "@marquee/db";
import { createSecretProvider, type SecretKind } from "@marquee/secrets";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { generateDeployKey } from "@/lib/deployKey";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ConnectionRow {
  id: string;
  appId: string;
  kind: "GIT" | "FIREBASE" | "ANDROID_KEYSTORE";
  metadata: unknown;
  lastTestedAt: Date | null;
  lastTestSucceeded: boolean | null;
  lastTestMessage: string | null;
}

export function connectionToDto(c: ConnectionRow): AppConnectionDto {
  return {
    id: c.id,
    appId: c.appId,
    kind: c.kind,
    status: c.lastTestSucceeded === false ? "ERROR" : "CONNECTED",
    metadata: (c.metadata as Record<string, unknown> | null) ?? null,
    lastTestedAt: c.lastTestedAt?.toISOString() ?? null,
    lastTestSucceeded: c.lastTestSucceeded,
    lastTestMessage: c.lastTestMessage,
  };
}

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  const { id: appId } = await context.params;
  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");
    const conns = await prisma.appConnection.findMany({
      where: { appId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ connections: conns.map(connectionToDto) });
  });
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id: appId } = await context.params;
  const body = CreateConnectionRequest.parse(await req.json());
  const sp = createSecretProvider();

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");

    // Reconnect semantics: replace any existing connection of the same kind.
    const existing = await prisma.appConnection.findFirst({ where: { appId, kind: body.kind } });
    if (existing) {
      await sp.delete(existing.secretRef).catch(() => undefined);
      await prismaUnscoped.appConnection.delete({ where: { id: existing.id } });
    }

    let content: string;
    let dbMeta: Record<string, unknown>;
    let secretMeta: Record<string, string> = {};
    let publicKey: string | undefined;

    if (body.kind === "GIT") {
      const key = await generateDeployKey(`marquee-${appId}`);
      content = key.privateKey;
      publicKey = key.publicKey;
      dbMeta = { repoUrl: body.repoUrl, branch: body.branch, publicKey };
    } else if (body.kind === "FIREBASE") {
      content = body.serviceAccountJson;
      const parsed = JSON.parse(body.serviceAccountJson) as { project_id?: string };
      dbMeta = {
        iosAppId: body.iosAppId ?? null,
        androidAppId: body.androidAppId ?? null,
        projectId: parsed.project_id ?? null,
        testerGroups: body.testerGroups,
      };
    } else {
      content = body.keystoreBase64;
      secretMeta = {
        storePassword: body.storePassword,
        keyPassword: body.keyPassword,
        keyAlias: body.keyAlias,
      };
      dbMeta = { keyAlias: body.keyAlias, usePlayAppSigning: body.usePlayAppSigning };
    }

    const created = await prisma.appConnection.create({
      data: {
        tenantId: ctx.tenant!.id,
        appId,
        kind: body.kind,
        secretRef: "pending",
        metadata: dbMeta as never,
        createdById: ctx.user.id,
      },
    });

    try {
      const secretKind: SecretKind = body.kind === "GIT" ? "GIT_SSH" : body.kind;
      const ref = await sp.put(ctx.tenant!.id, created.id, {
        kind: secretKind,
        content,
        metadata: secretMeta,
      });
      await prisma.appConnection.update({ where: { id: created.id }, data: { secretRef: ref } });
    } catch (err) {
      await prismaUnscoped.appConnection.delete({ where: { id: created.id } });
      throw err;
    }

    return NextResponse.json(
      { ...connectionToDto({ ...created, metadata: dbMeta }), publicKey },
      { status: 201 },
    );
  });
});
