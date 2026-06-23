/**
 * Per-request AI orchestrator factory.
 *
 *   const orch = await loadAiOrchestrator(tenantId);
 *
 * The chain is hydrated from:
 *   • `TenantSetting` key=`aso.aiProvider` (the user-chosen order)
 *   • One Credential row per `AiProviderKind` in the chain (kind =
 *     AI_ANTHROPIC | AI_OPENAI | AI_GEMINI), which carries the API key
 *     and an optional model override in `secretRef`.
 *
 * If no setting exists yet, `loadAiOrchestrator` throws a friendly
 * AiNotConfiguredError so the caller can prompt the user to visit the
 * AI settings page. There is no fallback "default provider" — the
 * tenant must explicitly pick one.
 */
import {
  AiChainConfigSchema,
  AiOrchestrator,
  makeAiProvider,
  resolveChainOrder,
  type AiChainConfig,
  type AiProvider,
  type AiProviderKind,
} from "@marquee/aso";
import { prisma } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { ValidationError } from "@marquee/core";

const secretProvider = createSecretProvider();

const PROVIDER_KIND_TO_CREDENTIAL_KIND: Record<
  AiProviderKind,
  "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI"
> = {
  claude: "AI_ANTHROPIC",
  openai: "AI_OPENAI",
  gemini: "AI_GEMINI",
};

export const CREDENTIAL_KIND_TO_PROVIDER_KIND: Record<
  "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI",
  AiProviderKind
> = {
  AI_ANTHROPIC: "claude",
  AI_OPENAI: "openai",
  AI_GEMINI: "gemini",
};

export class AiNotConfiguredError extends ValidationError {
  constructor(message: string) {
    super(message, { code: "AI_NOT_CONFIGURED" });
  }
}

export interface AiOrchestratorBuildResult {
  orchestrator: AiOrchestrator;
  config: AiChainConfig;
}

const SETTING_KEY = "aso.aiProvider";

/** Load the chain config from TenantSetting. Returns null when unset. */
export async function loadAiChainConfig(tenantId: string): Promise<AiChainConfig | null> {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: SETTING_KEY } },
  });
  if (!row) return null;
  const parsed = AiChainConfigSchema.safeParse(row.value);
  if (!parsed.success) return null;
  return parsed.data;
}

/** Save the chain config to TenantSetting. Throws on invalid input. */
export async function saveAiChainConfig(tenantId: string, config: unknown): Promise<AiChainConfig> {
  const parsed = AiChainConfigSchema.parse(config);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: SETTING_KEY } },
    create: { tenantId, key: SETTING_KEY, value: parsed },
    update: { value: parsed },
  });
  return parsed;
}

/** Returns the set of AiProviderKind that have an active credential. */
export async function listConfiguredProviders(
  tenantId: string,
): Promise<{ kind: AiProviderKind; credentialId: string; name: string }[]> {
  const creds = await prisma.credential.findMany({
    where: {
      tenantId,
      isActive: true,
      kind: { in: ["AI_ANTHROPIC", "AI_OPENAI", "AI_GEMINI"] },
    },
    orderBy: { createdAt: "asc" },
  });
  return creds.map((c) => ({
    kind: CREDENTIAL_KIND_TO_PROVIDER_KIND[c.kind as "AI_ANTHROPIC" | "AI_OPENAI" | "AI_GEMINI"],
    credentialId: c.id,
    name: c.name,
  }));
}

/**
 * Build an AiOrchestrator for the current tenant. The chain order is
 * whatever the user configured in TenantSetting — primary first, then
 * fallbacks in the order they were listed.
 */
export async function loadAiOrchestrator(
  tenantId: string,
  options: {
    onUsage?: (record: {
      provider: AiProviderKind;
      model: string;
      taskKind: string;
      usage: { inputTokens: number; outputTokens: number; usdCost: number };
    }) => void | Promise<void>;
  } = {},
): Promise<AiOrchestratorBuildResult> {
  let config = await loadAiChainConfig(tenantId);
  if (!config) {
    // No explicit chain config yet — derive a sensible default from any
    // active AI credentials the tenant has uploaded. First credential
    // by creation date becomes primary; the rest become fallbacks.
    // This lets a tenant who's added just one provider start using AI
    // without first having to visit a separate settings page.
    const available = await listConfiguredProviders(tenantId);
    if (available.length === 0) {
      throw new AiNotConfiguredError(
        "No AI provider configured for this workspace — add an OpenAI, Anthropic, or Gemini credential in Settings → Credentials, then try again.",
      );
    }
    const primary = available[0]!.kind;
    const fallbacks = available
      .slice(1, 3)
      .map((a) => a.kind)
      .filter((k) => k !== primary);
    config = { primary, fallbacks };
  }
  const order = resolveChainOrder(config);

  const providers: AiProvider[] = [];
  for (const kind of order) {
    const credentialKind = PROVIDER_KIND_TO_CREDENTIAL_KIND[kind];
    const cred = await prisma.credential.findFirst({
      where: { tenantId, kind: credentialKind, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!cred) {
      // Tenant configured a kind but never added (or deactivated) the
      // credential. Skip silently — the orchestrator handles empty
      // fallbacks gracefully as long as ≥1 provider remains.
      continue;
    }
    const material = await secretProvider.get(cred.secretRef);
    providers.push(
      makeAiProvider(kind, {
        apiKey: material.content.trim(),
        ...(material.metadata?.model ? { model: material.metadata.model } : {}),
      }),
    );
  }

  if (providers.length === 0) {
    throw new AiNotConfiguredError(
      "AI chain references providers without active credentials — re-pick in Settings → AI.",
    );
  }

  const orchestrator = new AiOrchestrator(providers, {
    onUsage: async (record) => {
      try {
        await recordAiUsage(tenantId, record);
      } catch {
        // Telemetry failure must not break the AI call.
      }
      await options.onUsage?.(record);
    },
  });
  return { orchestrator, config };
}

async function recordAiUsage(
  tenantId: string,
  record: {
    provider: AiProviderKind;
    model: string;
    usage: { inputTokens: number; outputTokens: number; usdCost: number };
  },
): Promise<void> {
  const yearMonth = new Date().toISOString().slice(0, 7);
  await prisma.aiUsage.upsert({
    where: {
      tenantId_provider_yearMonth: {
        tenantId,
        provider: record.provider,
        yearMonth,
      },
    },
    create: {
      tenantId,
      provider: record.provider,
      model: record.model,
      yearMonth,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      usdCost: record.usage.usdCost,
      requestCount: 1,
    },
    update: {
      model: record.model,
      inputTokens: { increment: record.usage.inputTokens },
      outputTokens: { increment: record.usage.outputTokens },
      usdCost: { increment: record.usage.usdCost },
      requestCount: { increment: 1 },
    },
  });
}
