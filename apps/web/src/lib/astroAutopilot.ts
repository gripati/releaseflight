/**
 * Server-side helper — load an AstroAutopilot instance from the tenant's
 * ASO_RESEARCH_MCP credential. Throws AstroNotConfiguredError when no
 * credential is configured so the API wrapper can convert it into a
 * shaped 503 response.
 */
import { prisma } from "@marquee/db";
import { AstroAutopilot } from "@marquee/aso";
import { AppError, assertSafeMcpEndpoint } from "@marquee/core";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();

export class AstroNotConfiguredError extends AppError {
  constructor() {
    super({
      code: "CREDENTIAL_INVALID",
      message:
        "No Astro MCP credential is connected. Add an ASO Research credential under Settings → Credentials first.",
      httpStatus: 503,
      details: { kind: "ASTRO_NOT_CONFIGURED" },
    });
    this.name = "AstroNotConfiguredError";
  }
}

export interface LoadedAutopilot {
  autopilot: AstroAutopilot;
  endpoint: string;
}

export async function loadAstroAutopilot(
  tenantId: string,
): Promise<LoadedAutopilot> {
  const cred = await prisma.credential.findFirst({
    where: { tenantId, kind: "ASO_RESEARCH_MCP", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!cred) throw new AstroNotConfiguredError();

  const meta = (cred.metadata as { endpoint?: string } | null) ?? {};
  if (!meta.endpoint) throw new AstroNotConfiguredError();
  // SSRF guard the user-supplied endpoint before any server-side fetch.
  await assertSafeMcpEndpoint(meta.endpoint);

  const material = await secretProvider.get(cred.secretRef);
  const apiKey = material.content.trim();
  return {
    autopilot: new AstroAutopilot({
      endpoint: meta.endpoint,
      ...(apiKey.length > 0 ? { apiKey } : {}),
    }),
    endpoint: meta.endpoint,
  };
}
