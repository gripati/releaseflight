/**
 * Multi-provider AI orchestrator.
 *
 *   const chain = [primaryProvider, ...fallbackProviders]; // user-defined
 *   const orchestrator = new AiOrchestrator(chain, { onUsage });
 *   const result = await orchestrator.run(task);
 *
 * The chain is supplied by the caller. The orchestrator never reorders
 * or hides providers — it walks the array in order until one returns
 * success or until every retriable error has been exhausted. The chain
 * order is whatever the tenant configured.
 */
import type {
  AiInvokeResult,
  AiProvider,
  AiTask,
  AiUsageRecorder,
} from "./types";

export interface AiOrchestratorOptions {
  /** Called once per successful invoke for cost / token bookkeeping. */
  onUsage?: AiUsageRecorder;
  /** Called once per failed attempt — useful for observability. */
  onAttempt?: (info: {
    provider: string;
    attempt: number;
    success: boolean;
    retriable: boolean;
    code?: string;
    message?: string;
    latencyMs?: number;
  }) => void;
}

export class AiOrchestrator {
  constructor(
    private readonly chain: AiProvider[],
    private readonly options: AiOrchestratorOptions = {},
  ) {
    if (chain.length === 0) {
      throw new Error(
        "AiOrchestrator created with empty chain — configure at least one AI provider in workspace settings.",
      );
    }
  }

  /** Convenience accessor for the configured order, primary first. */
  get providers(): readonly { kind: string; model: string }[] {
    return this.chain.map((p) => ({ kind: p.kind, model: p.model }));
  }

  async run<TIn, TOut>(task: AiTask<TIn, TOut>): Promise<AiInvokeResult<TOut>> {
    let lastFailure: AiInvokeResult<TOut> | null = null;

    for (let attempt = 0; attempt < this.chain.length; attempt += 1) {
      const provider = this.chain[attempt]!;
      const result = await provider.invoke(task);

      this.options.onAttempt?.({
        provider: provider.kind,
        attempt: attempt + 1,
        success: result.ok,
        retriable: result.ok ? false : result.retriable,
        ...(result.ok
          ? { latencyMs: result.latencyMs }
          : { code: result.code, message: result.message }),
      });

      if (result.ok) {
        try {
          await this.options.onUsage?.({
            provider: result.provider,
            model: result.model,
            taskKind: task.kind,
            usage: result.usage,
          });
        } catch {
          // Usage recording must never break a successful AI call.
        }
        return result;
      }

      lastFailure = result;
      if (!result.retriable) {
        // Non-retriable: validation error, auth error, schema mismatch.
        // Trying another model with the same prompt won't help.
        return result;
      }
      // Retriable: try the next provider in the chain.
    }

    return (
      lastFailure ?? {
        ok: false,
        provider: "claude",
        retriable: false,
        code: "UNKNOWN",
        message: "AI chain exhausted with no result",
      }
    );
  }
}
