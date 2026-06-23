"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Spinner, Stamp, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

interface Suggestion {
  keyword: string;
  rationale: string;
  predictedRelevance: number;
  bucket: "CORE" | "LONG_TAIL" | "COMPETITOR_BORROW" | "SYNONYM" | "BRAND";
  suggestedTerritory: string;
}

interface SuggestResponse {
  suggestions: Suggestion[];
  notes: string | null;
  provider: string;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; usdCost: number };
}

interface Props {
  appId: string;
  open: boolean;
  onClose: () => void;
}

const BUCKET_VARIANT: Record<Suggestion["bucket"], "default" | "success" | "warning" | "info"> = {
  CORE: "success",
  LONG_TAIL: "info",
  SYNONYM: "default",
  COMPETITOR_BORROW: "warning",
  BRAND: "default",
};

export function SuggestKeywordsSheet({ appId, open, onClose }: Props): JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SuggestResponse | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(10);

  async function run(): Promise<void> {
    setLoading(true);
    setData(null);
    setAdded(new Set());
    const res = await api<SuggestResponse>(`/api/v1/apps/${appId}/aso/keywords/suggest`, {
      method: "POST",
      body: { count },
    });
    setLoading(false);
    if (!res.ok) {
      toast.error("AI suggestion failed", { description: res.message });
      return;
    }
    setData(res.data);
  }

  async function trackOne(s: Suggestion): Promise<void> {
    const key = `${s.keyword}::${s.suggestedTerritory}`;
    setAdding(key);
    const res = await api(`/api/v1/apps/${appId}/aso/keywords`, {
      method: "POST",
      body: {
        keyword: s.keyword,
        territory: s.suggestedTerritory,
        source: "AI_SUGGESTED",
      },
    });
    setAdding(null);
    if (!res.ok) {
      toast.error(`Could not track "${s.keyword}"`, { description: res.message });
      return;
    }
    toast.success(`Tracking "${s.keyword}"`);
    setAdded(new Set([...added, key]));
    router.refresh();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="AI keyword suggestions"
      subtitle="Reviewed by you — nothing is tracked until you click."
      width={720}
    >
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                Count
              </label>
              <input
                type="number"
                min={5}
                max={25}
                value={count}
                onChange={(e) => setCount(Math.max(5, Math.min(25, Number(e.target.value))))}
                className="h-9 w-full rounded-[var(--radius-sm)] border-[0.5px] border-[var(--stroke-input)] bg-[var(--surface-elevated)] px-3 font-mono text-[13px] tabular-nums"
              />
            </div>
            <Button variant="primary" onClick={run} disabled={loading}>
              {loading ? <Spinner size={12} /> : data ? "Re-run" : "Suggest with AI"}
            </Button>
            {data && (
              <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                via {data.provider} · {data.model} · {data.latencyMs.toString()}ms ·
                {" "}
                ${data.usage.usdCost.toFixed(4)}
              </span>
            )}
          </div>
          {!data && !loading && (
            <p className="mt-3 font-body text-[12px] text-[var(--ink-secondary)]">
              We feed your app name, description, primary locale, and the keywords you already
              track to the model. It returns fresh candidates with a rationale — nothing
              auto-tracked until you click.
            </p>
          )}
        </Card>

        {data?.notes && (
          <Card className="border-dashed">
            <p className="font-body text-[12px] text-[var(--ink-secondary)]">
              <span className="font-mono uppercase tracking-[0.06em] text-[var(--ink-tertiary)]">
                Notes ·{" "}
              </span>
              {data.notes}
            </p>
          </Card>
        )}

        {data && (
          <ul className="space-y-2">
            {data.suggestions.map((s) => {
              const key = `${s.keyword}::${s.suggestedTerritory}`;
              const isAdded = added.has(key);
              const isAdding = adding === key;
              return (
                <li
                  key={key}
                  className={cn(
                    "rounded-[var(--radius)] border-[0.5px] p-3",
                    isAdded
                      ? "border-[var(--status-success)] bg-[var(--status-success-tint)]"
                      : "border-[var(--stroke-default)]",
                  )}
                >
                  <header className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="font-display text-lg"
                        style={{ fontVariationSettings: "'wght' 500" }}
                      >
                        {s.keyword}
                      </span>
                      <Stamp variant={BUCKET_VARIANT[s.bucket]}>{s.bucket}</Stamp>
                      <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                        {s.suggestedTerritory}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-[var(--ink-tertiary)]">
                        fit {s.predictedRelevance.toString()}/100
                      </span>
                    </div>
                    <Button
                      variant={isAdded ? "ghost" : "secondary"}
                      size="sm"
                      disabled={isAdded || isAdding}
                      onClick={() => trackOne(s)}
                    >
                      {isAdded ? "Tracked ✓" : isAdding ? <Spinner size={12} /> : "Track"}
                    </Button>
                  </header>
                  <p className="mt-2 font-body text-[13px] text-[var(--ink-secondary)]">
                    {s.rationale}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
