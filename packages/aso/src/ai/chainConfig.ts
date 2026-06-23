/**
 * Chain configuration helpers.
 *
 * The tenant picks the order — these helpers only validate / normalise.
 * No hardcoded preference between providers ever sneaks in here.
 */
import { z } from "zod";
import { AI_PROVIDER_KINDS, type AiProviderKind } from "./types";

/**
 * Shape persisted in TenantSetting where `key = "aso.aiProvider"`.
 *   {
 *     "primary": "openai",
 *     "fallbacks": ["claude", "gemini"]
 *   }
 */
export const AiChainConfigSchema = z
  .object({
    primary: z.enum(AI_PROVIDER_KINDS as unknown as [AiProviderKind, ...AiProviderKind[]]),
    fallbacks: z
      .array(z.enum(AI_PROVIDER_KINDS as unknown as [AiProviderKind, ...AiProviderKind[]]))
      .max(2)
      .default([]),
  })
  .refine((c) => !c.fallbacks.includes(c.primary), {
    message: "Primary provider cannot also appear in fallbacks",
  })
  .refine((c) => new Set(c.fallbacks).size === c.fallbacks.length, {
    message: "Fallback list cannot contain duplicates",
  });

export type AiChainConfig = z.infer<typeof AiChainConfigSchema>;

/**
 * Resolve the chain to an ordered list of provider kinds, primary
 * first. Returns at most 3 kinds (primary + up to 2 fallbacks).
 */
export function resolveChainOrder(config: AiChainConfig): AiProviderKind[] {
  return [config.primary, ...config.fallbacks];
}
