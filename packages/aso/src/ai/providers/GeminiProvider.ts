/**
 * Google Gemini provider.
 *
 * Schema-locked output via `responseSchema` + `responseMimeType:
 * "application/json"`. The Gemini API guarantees the output matches the
 * supplied JSON schema (subset of the spec — see Gemini docs).
 *
 * Default model: gemini-2.0-flash — cheapest tier with structured
 * output. Caller can override via material.model.
 */
import { GoogleGenerativeAI, type SchemaType } from "@google/generative-ai";
import type {
  AiInvokeResult,
  AiProvider,
  AiProviderCredentialMaterial,
  AiTask,
} from "../types";

const DEFAULT_MODEL = "gemini-2.0-flash";

// USD per million tokens — gemini-2.0-flash list price.
const COST_INPUT_PER_MTOK = 0.1;
const COST_OUTPUT_PER_MTOK = 0.4;

export class GeminiProvider implements AiProvider {
  readonly kind = "gemini" as const;
  readonly model: string;
  private readonly client: GoogleGenerativeAI;

  constructor(material: AiProviderCredentialMaterial) {
    if (!material.apiKey) {
      throw new Error("GeminiProvider: missing apiKey");
    }
    this.model = material.model ?? DEFAULT_MODEL;
    this.client = new GoogleGenerativeAI(material.apiKey);
  }

  async invoke<TIn, TOut>(task: AiTask<TIn, TOut>): Promise<AiInvokeResult<TOut>> {
    const startedAt = Date.now();
    try {
      const model = this.client.getGenerativeModel({
        model: this.model,
        generationConfig: {
          temperature: task.temperature ?? 0.2,
          maxOutputTokens: task.maxOutputTokens ?? 2048,
          responseMimeType: "application/json",
          responseSchema: task.jsonSchema as unknown as { type: SchemaType },
        },
        systemInstruction: task.systemPrompt,
      });

      const response = await model.generateContent(task.userPrompt);
      const text = response.response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "SCHEMA",
          message: `Gemini emitted invalid JSON: ${(parseErr as Error).message}`,
          raw: text,
        };
      }
      const parsed = task.outputSchema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "VALIDATION",
          message: `Schema mismatch: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          raw: json,
        };
      }

      const usage = response.response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const usdCost =
        (inputTokens / 1_000_000) * COST_INPUT_PER_MTOK +
        (outputTokens / 1_000_000) * COST_OUTPUT_PER_MTOK;

      return {
        ok: true,
        provider: this.kind,
        model: this.model,
        output: parsed.data,
        usage: {
          inputTokens,
          outputTokens,
          usdCost: Number(usdCost.toFixed(6)),
        },
        latencyMs: Date.now() - startedAt,
      };
    } catch (err: unknown) {
      return mapGeminiError(err, this.kind);
    }
  }
}

function mapGeminiError(err: unknown, kind: "gemini"): AiInvokeResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  // GoogleGenerativeAI doesn't ship a structured Error subclass with
  // status codes — fall back to message inspection. This isn't ideal
  // but it's what the SDK gives us.
  if (/API key not valid|invalid api key|authentication/i.test(message)) {
    return {
      ok: false,
      provider: kind,
      retriable: false,
      code: "AUTH",
      message: `Gemini auth failed: ${message}`,
      raw: err,
    };
  }
  if (/quota|rate.?limit|429/i.test(message)) {
    return {
      ok: false,
      provider: kind,
      retriable: true,
      code: "RATE_LIMIT",
      message: `Gemini rate-limit: ${message}`,
      raw: err,
    };
  }
  if (/5\d\d|internal|server/i.test(message)) {
    return {
      ok: false,
      provider: kind,
      retriable: true,
      code: "SERVER_5XX",
      message: `Gemini server error: ${message}`,
      raw: err,
    };
  }
  return {
    ok: false,
    provider: kind,
    retriable: true,
    code: "NETWORK",
    message: message,
    raw: err,
  };
}
