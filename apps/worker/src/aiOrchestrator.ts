/**
 * Worker-side AI orchestrator loader — mirrors apps/web/src/lib/aiOrchestrator.ts
 * but keeps only the pieces the worker needs (no usage-event telemetry,
 * no settings page). The Astro autopilot's locale enrichment step calls
 * this to transcreate Astro's English-dominant mining results into the
 * locale's language.
 */
import {
  AiChainConfigSchema,
  AiOrchestrator,
  makeAiProvider,
  resolveChainOrder,
  type AiProvider,
  type AiProviderKind,
} from "@marquee/aso";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";

const secretProvider = createSecretProvider();

const PROVIDER_KIND_TO_CREDENTIAL_KIND: Record<
  AiProviderKind,
  "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI"
> = {
  claude: "AI_ANTHROPIC",
  openai: "AI_OPENAI",
  gemini: "AI_GEMINI",
};

const SETTING_KEY = "aso.aiProvider";

/** Build an `AiOrchestrator` from whatever AI credentials the tenant
 *  has active. Returns null when no AI provider is configured — the
 *  caller falls back to "no enrichment" instead of failing the analyze
 *  job. */
export async function loadAiOrchestratorForTenant(
  tenantId: string,
): Promise<AiOrchestrator | null> {
  // 1) Prefer the chain the user explicitly configured.
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: SETTING_KEY } },
  });
  let order: AiProviderKind[] = [];
  if (row) {
    const parsed = AiChainConfigSchema.safeParse(row.value);
    if (parsed.success) order = resolveChainOrder(parsed.data);
  }

  // 2) Fallback: any active credential (oldest first).
  if (order.length === 0) {
    const creds = await prisma.credential.findMany({
      where: {
        tenantId,
        isActive: true,
        kind: { in: ["AI_ANTHROPIC", "AI_OPENAI", "AI_GEMINI"] },
      },
      orderBy: { createdAt: "asc" },
    });
    order = creds.map(
      (c) =>
        ({ AI_ANTHROPIC: "claude", AI_OPENAI: "openai", AI_GEMINI: "gemini" } as const)[
          c.kind as "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI"
        ],
    );
  }

  const providers: AiProvider[] = [];
  for (const kind of order) {
    const credentialKind = PROVIDER_KIND_TO_CREDENTIAL_KIND[kind];
    const cred = await prisma.credential.findFirst({
      where: { tenantId, kind: credentialKind, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!cred) continue;
    try {
      const material = await secretProvider.get(cred.secretRef);
      providers.push(
        makeAiProvider(kind, {
          apiKey: material.content.trim(),
          ...(material.metadata?.model ? { model: material.metadata.model } : {}),
        }),
      );
    } catch {
      // Bad credential material — skip and try the next provider.
    }
  }

  if (providers.length === 0) return null;
  return new AiOrchestrator(providers);
}
