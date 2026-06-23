/**
 * Multi-provider AI types.
 *
 * The AiOrchestrator runs an *ordered chain* of providers: primary first,
 * then fallbacks. The order is supplied by the caller — there is NO
 * hardcoded preference between providers. The user sets primary +
 * fallbacks in TenantSetting `aso.aiProvider`, the web layer hydrates
 * that into an ordered AiProvider[] and hands it to the orchestrator.
 *
 * Each provider implements `invoke(task)` and emits the same
 * AiInvokeResult shape so the orchestrator never has to know which
 * SDK it just spoke to.
 */
import type { ZodSchema } from "zod";

/** Stable identifiers used in TenantSetting JSON + AiUsage rows. */
export type AiProviderKind = "claude" | "openai" | "gemini";

export const AI_PROVIDER_KINDS: readonly AiProviderKind[] = ["claude", "openai", "gemini"];

/** Logical task type — drives prompt selection + cost categorisation. */
export type AiTaskKind =
  | "keyword.suggest"
  | "keyword.borrow"
  | "metadata.tighten"
  | "anomaly.explain"
  | "deploy.diagnose";

/**
 * One AI request. The `outputSchema` is the single source of truth for
 * what the model must produce — each provider uses its own structured-
 * output mechanism (Anthropic `tool_use`, OpenAI `response_format:
 * json_schema`, Gemini `responseSchema`) to enforce it. Hallucinated or
 * malformed JSON fails schema validation and the orchestrator treats
 * that as a NON-retriable error (no point retrying the same prompt on
 * another provider — re-issue with a better prompt instead).
 */
export interface AiTask<TInput, TOutput> {
  kind: AiTaskKind;
  input: TInput;
  /** Short, deterministic. Sets persona + global constraints. */
  systemPrompt: string;
  /** The actual request to the model. Should embed `input` already. */
  userPrompt: string;
  /** JSON schema (zod) the model output is validated against. */
  outputSchema: ZodSchema<TOutput>;
  /**
   * JSON-Schema form of `outputSchema` — providers that need a literal
   * schema (OpenAI / Gemini) consume this. `null` is fine for providers
   * that can derive from `outputSchema` via a tool definition (Anthropic).
   */
  jsonSchema: Record<string, unknown>;
  /** Pretty name for tool_use / function-calling. */
  taskName: string;
  taskDescription: string;
  /** Hard upper bound on output tokens. */
  maxOutputTokens?: number;
  /** Temperature 0..1 — defaults to 0.2 for grounded ASO work. */
  temperature?: number;
}

/** Token + cost meter emitted on every successful call. */
export interface AiUsageMeter {
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
}

export interface AiInvokeSuccess<TOutput> {
  ok: true;
  provider: AiProviderKind;
  model: string;
  output: TOutput;
  usage: AiUsageMeter;
  /** Wall-clock time for the call, in ms. */
  latencyMs: number;
}

export interface AiInvokeFailure {
  ok: false;
  provider: AiProviderKind;
  /**
   * Retriable failures (network glitch, 5xx, rate limit) cause the
   * orchestrator to try the next provider in the chain. Non-retriable
   * failures (4xx, schema validation, prompt error) short-circuit —
   * trying another model won't help.
   */
  retriable: boolean;
  code:
    | "NETWORK"
    | "RATE_LIMIT"
    | "SERVER_5XX"
    | "AUTH"
    | "VALIDATION"
    | "SCHEMA"
    | "BUDGET"
    | "TIMEOUT"
    | "UNKNOWN";
  message: string;
  /** Provider-specific error envelope for debugging. */
  raw?: unknown;
}

export type AiInvokeResult<TOutput> = AiInvokeSuccess<TOutput> | AiInvokeFailure;

export interface AiProvider {
  readonly kind: AiProviderKind;
  readonly model: string;
  invoke<TIn, TOut>(task: AiTask<TIn, TOut>): Promise<AiInvokeResult<TOut>>;
}

/** Credential material the web layer hands to each provider factory. */
export interface AiProviderCredentialMaterial {
  /** API key for OpenAI / Anthropic; service-account-style for Gemini. */
  apiKey: string;
  /** Optional override for the default model. */
  model?: string;
}

/** Hook the orchestrator calls after a successful invoke — used to
 *  persist token + cost numbers to the AiUsage table. */
export type AiUsageRecorder = (record: {
  provider: AiProviderKind;
  model: string;
  taskKind: AiTaskKind;
  usage: AiUsageMeter;
}) => Promise<void> | void;
