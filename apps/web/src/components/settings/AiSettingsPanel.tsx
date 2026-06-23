"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, ArrowUp, ArrowDown } from "lucide-react";
import { Button, Card, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { AddAiCredentialSheet } from "./AddAiCredentialSheet";

type ProviderKind = "claude" | "openai" | "gemini";

interface ConfiguredProvider {
  kind: ProviderKind;
  credentialId: string;
  name: string;
}

interface AiChainConfig {
  primary: ProviderKind;
  fallbacks: ProviderKind[];
}

interface Props {
  initialConfig: AiChainConfig | null;
  initialConfigured: ConfiguredProvider[];
}

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  claude: "Anthropic Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

const PROVIDER_SHORT: Record<ProviderKind, string> = {
  claude: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
};

export function AiSettingsPanel({ initialConfig, initialConfigured }: Props): JSX.Element {
  const router = useRouter();
  const [configured, setConfigured] = useState<ConfiguredProvider[]>(initialConfigured);
  const [primary, setPrimary] = useState<ProviderKind | null>(initialConfig?.primary ?? null);
  const [fallbacks, setFallbacks] = useState<ProviderKind[]>(initialConfig?.fallbacks ?? []);
  const [adding, setAdding] = useState<ProviderKind | null>(null);
  const [saving, startSaving] = useTransition();

  const configuredKinds = useMemo(
    () => new Set(configured.map((c) => c.kind)),
    [configured],
  );
  const unconfiguredKinds = (["claude", "openai", "gemini"] as ProviderKind[]).filter(
    (k) => !configuredKinds.has(k),
  );

  // Candidates the user can promote to fallback: configured but not primary, not already in fallbacks
  const fallbackCandidates = useMemo(() => {
    return configured
      .map((c) => c.kind)
      .filter((k) => k !== primary && !fallbacks.includes(k));
  }, [configured, primary, fallbacks]);

  function moveFallback(idx: number, dir: -1 | 1): void {
    const next = [...fallbacks];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    setFallbacks(next);
  }

  function removeFallback(idx: number): void {
    setFallbacks(fallbacks.filter((_, i) => i !== idx));
  }

  function addFallback(kind: ProviderKind): void {
    if (fallbacks.length >= 2) {
      toast.error("Up to 2 fallbacks supported");
      return;
    }
    setFallbacks([...fallbacks, kind]);
  }

  async function handleSave(): Promise<void> {
    if (!primary) {
      toast.error("Pick a primary provider first");
      return;
    }
    startSaving(() => {
      void (async () => {
        const res = await api(`/api/v1/aso/ai-config`, {
          method: "PUT",
          body: { primary, fallbacks },
        });
        if (!res.ok) {
          toast.error("Could not save chain", { description: res.message });
          return;
        }
        toast.success("AI chain saved", {
          description: `${PROVIDER_SHORT[primary]} → ${fallbacks.map((f) => PROVIDER_SHORT[f]).join(" → ") || "no fallback"}`,
        });
        router.refresh();
      })();
    });
  }

  function handleCredentialAdded(kind: ProviderKind, credentialId: string, name: string): void {
    setConfigured([...configured, { kind, credentialId, name }]);
    setAdding(null);
    router.refresh();
  }

  const dirty = useMemo(() => {
    const initFallbacks = initialConfig?.fallbacks ?? [];
    if (initialConfig?.primary !== primary) return true;
    if (fallbacks.length !== initFallbacks.length) return true;
    return fallbacks.some((f, i) => f !== initFallbacks[i]);
  }, [primary, fallbacks, initialConfig]);

  return (
    <div className="space-y-8">
      <Card>
        <header className="mb-4">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Configured providers
          </h2>
          <p className="mt-1 font-body text-[13px] text-[var(--ink-secondary)]">
            Add at least one provider here, then pick the chain order below. Your selection is
            never overridden by a default order.
          </p>
        </header>
        <ul className="space-y-2">
          {configured.map((c) => (
            <li
              key={c.credentialId}
              className="flex items-center justify-between gap-3 rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <Stamp variant="success">{PROVIDER_SHORT[c.kind].toUpperCase()}</Stamp>
                <span className="font-body text-[13px]">{c.name}</span>
              </div>
              <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                {PROVIDER_LABEL[c.kind]}
              </span>
            </li>
          ))}
          {unconfiguredKinds.map((kind) => (
            <li
              key={kind}
              className="flex items-center justify-between gap-3 rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <Stamp>NOT ADDED</Stamp>
                <span className="font-body text-[13px] text-[var(--ink-secondary)]">
                  {PROVIDER_LABEL[kind]}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setAdding(kind)}>
                <Plus size={14} /> Add key
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <header className="mb-4">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Chain order
          </h2>
          <p className="mt-1 font-body text-[13px] text-[var(--ink-secondary)]">
            Pick whichever you want as primary. Fallbacks fire only on retriable failures
            (network, rate-limit, 5xx). Order matters — top of the fallback list is tried first.
          </p>
        </header>

        <section className="mb-6">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            Primary
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(["claude", "openai", "gemini"] as ProviderKind[]).map((kind) => {
              const isConfigured = configuredKinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={!isConfigured}
                  onClick={() => {
                    setPrimary(kind);
                    // Remove from fallbacks if user picks an existing fallback as primary
                    setFallbacks(fallbacks.filter((f) => f !== kind));
                  }}
                  className={cn(
                    "rounded-[var(--radius)] border-[0.5px] px-4 py-3 text-left transition-all",
                    primary === kind
                      ? "border-[var(--ink-primary)] bg-[var(--surface-tinted)]"
                      : "border-[var(--stroke-default)] hover:border-[var(--ink-secondary)]",
                    !isConfigured && "cursor-not-allowed opacity-40",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="font-display text-base"
                      style={{ fontVariationSettings: "'wght' 500" }}
                    >
                      {PROVIDER_SHORT[kind]}
                    </span>
                    {primary === kind && <Stamp variant="success">PRIMARY</Stamp>}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-[var(--ink-tertiary)]">
                    {PROVIDER_LABEL[kind]}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Fallbacks (in order)
            </h3>
            <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
              {fallbacks.length}/2 used
            </span>
          </div>
          {fallbacks.length === 0 ? (
            <p className="rounded-[var(--radius)] border-[0.5px] border-dashed border-[var(--stroke-default)] px-3 py-4 font-body text-[12px] text-[var(--ink-tertiary)]">
              No fallbacks selected. If the primary returns a retriable error, the request just
              fails without retrying — add at least one fallback for resilience.
            </p>
          ) : (
            <ol className="space-y-2">
              {fallbacks.map((f, idx) => (
                <li
                  key={f}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-sunken)] px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                      {(idx + 1).toString()}
                    </span>
                    <Stamp>{PROVIDER_SHORT[f].toUpperCase()}</Stamp>
                    <span className="font-body text-[13px]">{PROVIDER_LABEL[f]}</span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => moveFallback(idx, -1)}
                      disabled={idx === 0}
                      aria-label="Move up"
                      className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] p-1 hover:border-[var(--ink-primary)] disabled:opacity-30"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveFallback(idx, 1)}
                      disabled={idx === fallbacks.length - 1}
                      aria-label="Move down"
                      className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] p-1 hover:border-[var(--ink-primary)] disabled:opacity-30"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFallback(idx)}
                      aria-label="Remove fallback"
                      className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] p-1 hover:border-[var(--status-danger)] hover:text-[var(--status-danger)]"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {fallbackCandidates.length > 0 && fallbacks.length < 2 && (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
                Add fallback:
              </span>
              {fallbackCandidates.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => addFallback(k)}
                  className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] px-2 py-1 font-mono text-[11px] uppercase hover:border-[var(--ink-primary)]"
                >
                  + {PROVIDER_SHORT[k]}
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="mt-6 flex items-center justify-end gap-3 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {primary
              ? `${PROVIDER_SHORT[primary]}${fallbacks.length > 0 ? " → " + fallbacks.map((f) => PROVIDER_SHORT[f]).join(" → ") : ""}`
              : "Pick a primary"}
          </span>
          <Button
            variant="primary"
            disabled={!primary || !dirty || saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save chain"}
          </Button>
        </div>
      </Card>

      {adding && (
        <AddAiCredentialSheet
          kind={adding}
          open
          onClose={() => setAdding(null)}
          onSaved={(credentialId, name) => handleCredentialAdded(adding, credentialId, name)}
        />
      )}
    </div>
  );
}
