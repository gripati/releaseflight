/**
 * OpenAI provider.
 *
 * Schema-locked output via `response_format: { type: "json_schema", ...,
 * strict: true }`. OpenAI guarantees the output JSON conforms to the
 * given schema (strict mode enforces it at the token sampler).
 *
 * Default model: gpt-4o-mini — cheap, structured output, plenty for
 * ASO. Caller can override.
 */
import OpenAI from "openai";
import type {
  AiInvokeResult,
  AiProvider,
  AiProviderCredentialMaterial,
  AiTask,
} from "../types";

const DEFAULT_MODEL = "gpt-4o-mini";

// USD per million tokens — gpt-4o-mini list price.
const COST_INPUT_PER_MTOK = 0.15;
const COST_OUTPUT_PER_MTOK = 0.6;

export class OpenAIProvider implements AiProvider {
  readonly kind = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(material: AiProviderCredentialMaterial) {
    if (!material.apiKey) {
      throw new Error("OpenAIProvider: missing apiKey");
    }
    this.model = material.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({ apiKey: material.apiKey });
  }

  async invoke<TIn, TOut>(task: AiTask<TIn, TOut>): Promise<AiInvokeResult<TOut>> {
    const startedAt = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: task.temperature ?? 0.2,
        max_tokens: task.maxOutputTokens ?? 2048,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: task.taskName,
            description: task.taskDescription,
            schema: task.jsonSchema,
            strict: true,
          },
        },
        messages: [
          { role: "system", content: task.systemPrompt },
          { role: "user", content: task.userPrompt },
        ],
      });

      const text = response.choices[0]?.message.content;
      if (!text) {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "SCHEMA",
          message: "OpenAI returned no content",
          raw: response,
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "SCHEMA",
          message: `OpenAI emitted invalid JSON: ${(parseErr as Error).message}`,
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

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
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
      return mapOpenAiError(err, this.kind);
    }
  }
}

function mapOpenAiError(err: unknown, kind: "openai"): AiInvokeResult<never> {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) {
      return {
        ok: false,
        provider: kind,
        retriable: false,
        code: "AUTH",
        message: `OpenAI auth failed (${status.toString()})`,
        raw: err,
      };
    }
    if (status === 429) {
      return {
        ok: false,
        provider: kind,
        retriable: true,
        code: "RATE_LIMIT",
        message: "OpenAI rate-limit (429)",
        raw: err,
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        provider: kind,
        retriable: true,
        code: "SERVER_5XX",
        message: `OpenAI server error ${status.toString()}`,
        raw: err,
      };
    }
    return {
      ok: false,
      provider: kind,
      retriable: false,
      code: "UNKNOWN",
      message: err.message,
      raw: err,
    };
  }
  return {
    ok: false,
    provider: kind,
    retriable: true,
    code: "NETWORK",
    message: err instanceof Error ? err.message : "OpenAI call failed",
    raw: err,
  };
}
