/**
 * Worker-side Astro loader. Mirrors apps/web/src/lib/researchProviders.ts
 * because the worker can't import from the web app.
 *
 * Astro is now the single source of truth for ASO signal data — the
 * old MultiProviderResearcher chain (AppleSearchAds + AppleSearchHints
 * + AstroMcp) was removed. Only `aso.astro.analyze` consumes this
 * loader today; the legacy `aso.keywords.refresh` job has been deleted.
 */
import { prisma } from "@marquee/db";
import { AstroAutopilot } from "@marquee/aso";
import { assertSafeMcpEndpoint } from "@marquee/core";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();

/** Build an AstroAutopilot for the tenant, or null when no
 *  ASO_RESEARCH_MCP credential is configured. */
export async function loadAstroAutopilotForTenant(
  tenantId: string,
): Promise<{ autopilot: AstroAutopilot; endpoint: string } | null> {
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
