import { NextResponse, type NextRequest } from "next/server";
import { CreateCredentialRequest, type CredentialDto } from "@marquee/api-contracts";
import { prisma, prismaUnscoped } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { CredentialInvalidError, ValidationError } from "@marquee/core";

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async () => {
  return withTenantContext(async (ctx) => {
    const credentials = await prisma.credential.findMany({
      where: { isActive: true, tenantId: ctx.tenant!.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { apps: true } } },
    });

    const dto: CredentialDto[] = credentials.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      appleKeyId: c.appleKeyId,
      appleIssuerId: c.appleIssuerId,
      googleClientEmail: c.googleClientEmail,
      googleProjectId: c.googleProjectId,
      lastTestedAt: c.lastTestedAt?.toISOString() ?? null,
      lastTestSucceeded: c.lastTestSucceeded,
      lastTestMessage: c.lastTestMessage,
      appCount: c._count.apps,
      createdAt: c.createdAt.toISOString(),
      rotatedAt: c.rotatedAt?.toISOString() ?? null,
      isActive: c.isActive,
    }));
    return NextResponse.json({ credentials: dto });
  });
});

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");

  const body = CreateCredentialRequest.parse(await req.json());

  const secretProvider = createSecretProvider();

  return withTenantContext(async () => {
    const tenantId = ctx.tenant!.id;

    // The metadata-only DB fields, shared by the create + update paths.
    const dataFields = {
      name: body.name,
      // appleKeyId stores the key id for APPLE App Store Connect.
      appleKeyId: body.kind === "APPLE" ? body.keyId : null,
      appleIssuerId: body.kind === "APPLE" ? body.issuerId : null,
      appleVendorNumber: body.kind === "APPLE" ? body.vendorNumber ?? null : null,
      googleClientEmail:
        body.kind === "GOOGLE"
          ? (JSON.parse(body.serviceAccountJson) as { client_email: string }).client_email
          : null,
      googleProjectId:
        body.kind === "GOOGLE"
          ? (JSON.parse(body.serviceAccountJson) as { project_id?: string }).project_id ?? null
          : null,
      // ASO_RESEARCH_MCP carries endpoint + optional toolName on the
      // metadata JSON column (no dedicated DB column).
      metadata:
        body.kind === "ASO_RESEARCH_MCP"
          ? { endpoint: body.endpoint, ...(body.toolName ? { toolName: body.toolName } : {}) }
          : undefined,
    };

    // Idempotent add: if a credential with the SAME identity already exists in
    // this tenant, UPDATE it (re-store/rotate the secret in place) instead of
    // creating a duplicate — so the credential keeps its id and any apps that
    // reference it stay linked. This is how a user recovers a lost key or
    // rotates one without first disconnecting every app (DELETE refuses while
    // apps reference it). Matched by the kind's stable identity.
    const identityWhere =
      body.kind === "APPLE"
        ? { tenantId, kind: "APPLE" as const, appleKeyId: body.keyId, appleIssuerId: body.issuerId }
        : body.kind === "GOOGLE"
          ? {
              tenantId,
              kind: "GOOGLE" as const,
              googleClientEmail: (JSON.parse(body.serviceAccountJson) as { client_email: string })
                .client_email,
            }
          : body.kind === "ASO_RESEARCH_MCP"
            ? {
                tenantId,
                kind: "ASO_RESEARCH_MCP" as const,
                metadata: { path: ["endpoint"], equals: body.endpoint },
              }
            : null;
    const existing = identityWhere
      ? await prisma.credential.findFirst({ where: identityWhere, select: { id: true } })
      : null;

    // Allocate / reuse the row id. Updating reactivates + clears the stale test
    // result (the new secret must be re-tested); creating starts secretRef pending.
    const created = existing
      ? await prisma.credential.update({
          where: { id: existing.id },
          data: {
            ...dataFields,
            isActive: true,
            rotatedAt: new Date(),
            lastTestedAt: null,
            lastTestSucceeded: null,
            lastTestMessage: null,
          },
        })
      : await prisma.credential.create({
          data: { tenantId, kind: body.kind, ...dataFields, secretRef: "pending", createdById: ctx.user.id },
        });

    try {
      const isAi =
        body.kind === "AI_ANTHROPIC" || body.kind === "AI_OPENAI" || body.kind === "AI_GEMINI";
      const content =
        body.kind === "APPLE"
          ? body.privateKeyPem
          : body.kind === "ASO_RESEARCH_MCP"
            ? // apiKey is optional for ASO_RESEARCH_MCP (local Astro
              // Desktop needs no auth). Persist an empty string so the
              // secret store keeps a deterministic ref shape.
              body.apiKey ?? ""
            : isAi
              ? body.apiKey
              : body.serviceAccountJson;
      const metadata: Record<string, string> =
        body.kind === "APPLE"
          ? { keyId: body.keyId, issuerId: body.issuerId }
          : body.kind === "ASO_RESEARCH_MCP"
            ? {
                endpoint: body.endpoint,
                ...(body.toolName ? { toolName: body.toolName } : {}),
              }
            : isAi && body.model
              ? { model: body.model }
              : {};
      const ref = await secretProvider.put(ctx.tenant!.id, created.id, {
        kind: body.kind,
        content,
        metadata,
      });
      await prisma.credential.update({ where: { id: created.id }, data: { secretRef: ref } });
    } catch (err) {
      // Roll back ONLY a freshly-created row on secret-store failure. Never
      // delete a pre-existing credential (it has apps linked) — leave it intact;
      // its prior secret is unchanged on failure.
      if (!existing) {
        await prismaUnscoped.credential.delete({ where: { id: created.id } });
      }
      if (err instanceof Error && err.message.includes("Invalid")) {
        throw new ValidationError(err.message);
      }
      throw err instanceof CredentialInvalidError ? err : err;
    }

    return NextResponse.json(
      { id: created.id, name: created.name, kind: created.kind, updated: Boolean(existing) },
      { status: existing ? 200 : 201 },
    );
  });
});
