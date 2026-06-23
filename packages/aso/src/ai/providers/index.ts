/**
 * Factory: turn a provider kind + credential material into an
 * AiProvider instance. The web layer uses this to build the chain in
 * whatever order the tenant configured — there is no implicit
 * ordering here.
 */
import type { AiProvider, AiProviderCredentialMaterial, AiProviderKind } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { GeminiProvider } from "./GeminiProvider";

export { AnthropicProvider, OpenAIProvider, GeminiProvider };

export function makeAiProvider(
  kind: AiProviderKind,
  material: AiProviderCredentialMaterial,
): AiProvider {
  switch (kind) {
    case "claude":
      return new AnthropicProvider(material);
    case "openai":
      return new OpenAIProvider(material);
    case "gemini":
      return new GeminiProvider(material);
  }
}
