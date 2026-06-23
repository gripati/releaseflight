/**
 * Anthropic / Claude provider.
 *
 * Schema-locked output via `tool_use`: we declare a single tool whose
 * `input_schema` is the task's JSON schema and force the model to call
 * it (`tool_choice: { type: "tool", name }`). Claude returns the
 * tool_use input block; we parse + zod-validate it.
 *
 * Default model: claude-sonnet-4-6 (cheap + fast, more than enough for
 * ASO suggestion tasks). Caller can override via credential material.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AiInvokeResult, AiProvider, AiProviderCredentialMaterial, AiTask } from "../types";

const DEFAULT_MODEL = "claude-sonnet-4-6";

// USD per million tokens — keep in sync with Anthropic pricing page.
// Sonnet-class: input $3, output $15 per MTok. Conservative.
const COST_INPUT_PER_MTOK = 3.0;
const COST_OUTPUT_PER_MTOK = 15.0;

export class AnthropicProvider implements AiProvider {
  readonly kind = "claude" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(material: AiProviderCredentialMaterial) {
    if (!material.apiKey) {
      throw new Error("AnthropicProvider: missing apiKey");
    }
    this.model = material.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey: material.apiKey });
  }

  async invoke<TIn, TOut>(task: AiTask<TIn, TOut>): Promise<AiInvokeResult<TOut>> {
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: task.maxOutputTokens ?? 2048,
        temperature: task.temperature ?? 0.2,
        system: task.systemPrompt,
        tools: [
          {
            name: task.taskName,
            description: task.taskDescription,
            input_schema: task.jsonSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: task.taskName },
        messages: [{ role: "user", content: task.userPrompt }],
      });

      const toolUse = response.content.find((c) => c.type === "tool_use");
      if (toolUse?.type !== "tool_use") {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "SCHEMA",
          message: "Anthropic did not emit a tool_use block",
          raw: response.content,
        };
      }
      const parsed = task.outputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        return {
          ok: false,
          provider: this.kind,
          retriable: false,
          code: "VALIDATION",
          message: `Schema mismatch: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          raw: toolUse.input,
        };
      }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
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
      return mapAnthropicError(err, this.kind);
    }
  }
}

function mapAnthropicError(err: unknown, kind: "claude"): AiInvokeResult<never> {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) {
      return {
        ok: false,
        provider: kind,
        retriable: false,
        code: "AUTH",
        message: `Anthropic auth failed (${status.toString()})`,
        raw: err,
      };
    }
    if (status === 429) {
      return {
        ok: false,
        provider: kind,
        retriable: true,
        code: "RATE_LIMIT",
        message: "Anthropic rate-limit (429)",
        raw: err,
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        provider: kind,
        retriable: true,
        code: "SERVER_5XX",
        message: `Anthropic server error ${status.toString()}`,
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
  if (err instanceof Error && err.name === "AbortError") {
    return {
      ok: false,
      provider: kind,
      retriable: true,
      code: "TIMEOUT",
      message: "Anthropic request aborted",
      raw: err,
    };
  }
  return {
    ok: false,
    provider: kind,
    retriable: true,
    code: "NETWORK",
    message: err instanceof Error ? err.message : "Anthropic call failed",
    raw: err,
  };
}
