import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { AppleAuth, GoogleAuth, GOOGLE_SCOPES, NotFoundError, assertSafeMcpEndpoint } from "@marquee/core";
import { AstroMcpClient } from "@marquee/aso";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

const appleAuth = new AppleAuth();
const googleAuth = new GoogleAuth();

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const params = await context.params;

  const sp = createSecretProvider();

  return withTenantContext(async () => {
    // Defense-in-depth: explicit tenant scoping in addition to RLS.
    const cred = await prisma.credential.findFirst({
      where: { id: params.id, tenantId: ctx.tenant!.id },
    });
    if (!cred) throw new NotFoundError("Credential not found");

    const material = await sp.get(cred.secretRef);

    let result: { ok: boolean; message: string };
    if (cred.kind === "APPLE") {
      if (!cred.appleKeyId || !cred.appleIssuerId) {
        result = { ok: false, message: "Missing Apple keyId or issuerId in DB row" };
      } else {
        result = await appleAuth.testConnection({
          id: cred.id,
          keyId: cred.appleKeyId,
          issuerId: cred.appleIssuerId,
          privateKeyPem: material.content,
        });
      }
    } else if (cred.kind === "GOOGLE") {
      try {
        const parsed = JSON.parse(material.content) as {
          client_email: string;
          private_key: string;
          project_id?: string;
        };
        result = await googleAuth.testConnection(
          {
            id: cred.id,
            clientEmail: parsed.client_email,
            privateKeyPem: parsed.private_key,
            projectId: parsed.project_id,
          },
          GOOGLE_SCOPES.ANDROID_PUBLISHER,
        );
      } catch (err: unknown) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    } else if (cred.kind === "ASO_RESEARCH_MCP") {
      // Astro / AppTweak / Sensor Tower — do a real ping() against the
      // MCP endpoint. AstroMcpClient.ping() calls `list_apps` which
      // every MCP-shaped server should respond to. Failures bubble back
      // as a clear message ("connection refused", "HTTP 401", etc.) so
      // the user knows immediately whether the URL + token are right.
      const meta = (cred.metadata as { endpoint?: string } | null) ?? {};
      if (!meta.endpoint) {
        result = { ok: false, message: "Missing endpoint URL in credential metadata." };
      } else {
        const apiKey = material.content.trim();
        try {
          // SSRF guard the user-supplied endpoint before the server fetches it.
          await assertSafeMcpEndpoint(meta.endpoint);
          const client = new AstroMcpClient({
            endpoint: meta.endpoint,
            ...(apiKey.length > 0 ? { apiKey } : {}),
            retries: 0,
            timeoutMs: 5000,
          });
          result = await client.ping();
        } catch (err: unknown) {
          result = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }
    } else {
      // AI_* — no liveness handshake. We just confirm the secret
      // material loaded; deeper checks happen on first real call from
      // the orchestrator.
      result = { ok: true, message: `${cred.kind} credential stored — liveness verified on first use.` };
    }

    const now = new Date();
    await prisma.credential.update({
      where: { id: cred.id },
      data: {
        lastTestedAt: now,
        lastTestSucceeded: result.ok,
        lastTestMessage: result.message,
      },
    });

    return NextResponse.json({
      ok: result.ok,
      message: result.message,
      testedAt: now.toISOString(),
    });
  });
});
