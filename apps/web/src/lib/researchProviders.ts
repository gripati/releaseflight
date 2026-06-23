/**
 * Tenant-scoped Astro autopilot loader.
 *
 * Astro is now the single source of truth for ASO signal data. The
 * multi-provider fusion (AppleSearchHints / AppleSearchAds / Google
 * Trends) was removed — see docs/16_ASO_INTELLIGENCE.md. Web API
 * routes that need ASO data hit one of the `/aso/astro/*` endpoints;
 * this file just gives those routes an autopilot instance to talk
 * to Astro MCP with.
 */
import { prisma } from "@marquee/db";
import { AstroAutopilot } from "@marquee/aso";
import { assertSafeMcpEndpoint } from "@marquee/core";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();

export interface AstroLoadResult {
  autopilot: AstroAutopilot;
  endpoint: string;
}

/**
 * Returns the tenant's Astro autopilot, or null when no
 * ASO_RESEARCH_MCP credential is configured. Callers must treat null
 * as "Astro not set up" and surface a CTA to connect.
 */
export async function loadAstroAutopilotForTenant(
  tenantId: string,
): Promise<AstroLoadResult | null> {
  const cred = await prisma.credential.findFirst({
    where: { tenantId, kind: "ASO_RESEARCH_MCP", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!cred) return null;
  const meta = (cred.metadata as { endpoint?: string } | null) ?? {};
  if (!meta.endpoint) return null;
  try {
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
  } catch {
    return null;
  }
}
