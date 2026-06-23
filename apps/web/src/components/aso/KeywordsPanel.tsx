"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { SuggestKeywordsSheet } from "./SuggestKeywordsSheet";

export interface KeywordSignalSnapshot {
  date: string;
  appStoreRank: number | null;
  /** Astro popularity (0–100, Apple's real search index). */
  volume: number | null;
  maxVolume: number | null;
  /** Astro 0–100 keyword difficulty. */
  difficulty: number | null;
  maxReachChance: number | null;
  score: number | null;
  bucket: string | null;
}

export interface KeywordRow {
  id: string;
  keyword: string;
  territory: string;
  source: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  notes: string | null;
  latestSignal: KeywordSignalSnapshot | null;
}

interface Props {
  appId: string;
  initial: KeywordRow[];
}

const STATUS_FILTERS: readonly ("ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL")[] = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "ALL",
];

export function KeywordsPanel({ appId, initial }: Props): JSX.Element {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [territory, setTerritory] = useState("US");
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("ACTIVE");
  const [adding, setAdding] = useState(false);
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [importingMeta, setImportingMeta] = useState(false);

  const filtered = filter === "ALL" ? initial : initial.filter((k) => k.status === filter);

  async function handleImportFromMetadata(): Promise<void> {
    setImportingMeta(true);
    const res = await api<{
      importedCount: number;
      skippedExisting: number;
      perLocale: { locale: string; tokens: number; imported: number }[];
    }>(`/api/v1/apps/${appId}/aso/keywords/sync-from-metadata`, {
      method: "POST",
      body: {},
    });
    setImportingMeta(false);
    if (!res.ok) {
      toast.error("Could not import keywords from metadata", { description: res.message });
      return;
    }
    const { importedCount, skippedExisting, perLocale } = res.data;
    if (importedCount === 0 && skippedExisting === 0) {
      toast("No keywords found in metadata", {
        description: "Fetch metadata first, or fill in the keywords field per locale.",
      });
    } else {
      toast.success(
        `Imported ${importedCount.toString()} keyword${importedCount === 1 ? "" : "s"}`,
        {
          description: `${perLocale.length.toString()} locale${perLocale.length === 1 ? "" : "s"} scanned · ${skippedExisting.toString()} already tracked`,
        },
      );
    }
    startTransition(() => router.refresh());
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = keyword.trim();
    if (!trimmed) return;
    setAdding(true);
    const res = await api(`/api/v1/apps/${appId}/aso/keywords`, {
      method: "POST",
      body: { keyword: trimmed, territory, source: "MANUAL" },
    });
    setAdding(false);
    if (!res.ok) {
      toast.error("Could not track keyword", { description: res.message });
      return;
    }
    toast.success("Keyword added", { description: `${trimmed} · ${territory}` });
    setKeyword("");
    startTransition(() => router.refresh());
  }

  async function handleStatusChange(row: KeywordRow, next: KeywordRow["status"]): Promise<void> {
    setBusyId(row.id);
    const res = await api(`/api/v1/apps/${appId}/aso/keywords/${row.id}`, {
      method: "PATCH",
      body: { status: next },
    });
    setBusyId(null);
    if (!res.ok) {
      toast.error("Update failed", { description: res.message });
      return;
    }
    toast.success(`Marked ${next.toLowerCase()}`);
    startTransition(() => router.refresh());
  }

  async function handleDelete(row: KeywordRow): Promise<void> {
    if (!confirm(`Remove "${row.keyword}" from tracking?`)) return;
    setBusyId(row.id);
    const res = await api(`/api/v1/apps/${appId}/aso/keywords/${row.id}`, { method: "DELETE" });
    setBusyId(null);
    if (!res.ok) {
      toast.error("Delete failed", { description: res.message });
      return;
    }
    toast.success("Keyword removed");
    startTransition(() => router.refresh());
  }

  return (
    <div className="page-loaded space-y-6">
      <Card>
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            Track a keyword
          </h2>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={handleImportFromMetadata}
              disabled={importingMeta}
            >
              {importingMeta ? "Importing…" : "Import from metadata"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSuggestOpen(true)}>
              Suggest with AI
            </Button>
            {/* Keyword signals come from Astro now — run Astro Autopilot on
             *  the metadata workbench. The dedicated "Refresh signals"
             *  button used to enqueue aso.keywords.refresh; that job has
             *  been removed in favour of Astro as the single source of
             *  truth. */}
          </div>
        </header>
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              Keyword
            </label>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. tower defense"
              maxLength={80}
              required
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              Country
            </label>
            <Input
              value={territory}
              onChange={(e) => setTerritory(e.target.value.toUpperCase())}
              placeholder="US"
              maxLength={2}
              pattern="[A-Z]{2}"
              required
            />
          </div>
          <Button type="submit" disabled={adding || keyword.trim().length === 0}>
            {adding ? "Adding…" : "Track"}
          </Button>
        </form>
      </Card>

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Filter
        </span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-[var(--radius)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] uppercase transition-colors",
              filter === f
                ? "border-[var(--status-info)] bg-[var(--status-info-tint)] text-[var(--status-info)]"
                : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card className="border-dashed">
          <p className="font-body text-[13px] text-[var(--ink-secondary)]">
            {filter === "ACTIVE"
              ? "No active keywords yet. Track one above to start collecting signals."
              : `No keywords with status ${filter.toLowerCase()}.`}
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <div className="min-w-[920px]">
            <div className="grid grid-cols-[1fr_60px_110px_70px_70px_70px_90px_80px_140px] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
              <span>Keyword</span>
              <span>CC</span>
              <span>Bucket</span>
              <span className="text-right">Score</span>
              <span className="text-right" title="Astro popularity 0–100">
                Pop.
              </span>
              <span className="text-right" title="Astro difficulty 0–100">
                Diff.
              </span>
              <span className="text-right">Rank</span>
              <span className="text-right" title="Astro max reach chance">
                Reach
              </span>
              <span className="text-right">Actions</span>
            </div>
            {filtered.map((k) => {
              const s = k.latestSignal;
              const isBusy = busyId === k.id;
              return (
                <div
                  key={k.id}
                  className="grid grid-cols-[1fr_60px_110px_70px_70px_70px_90px_80px_140px] items-center gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2 font-mono text-[12px] tabular-nums"
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="truncate">{k.keyword}</span>
                    {k.source !== "MANUAL" && (
                      <Stamp variant="default">{shortSource(k.source)}</Stamp>
                    )}
                  </div>
                  <span className="text-[var(--ink-secondary)] uppercase">{k.territory}</span>
                  <span>
                    {s?.bucket ? (
                      <Stamp variant={bucketVariant(s.bucket)}>{s.bucket}</Stamp>
                    ) : (
                      <span className="text-[var(--ink-tertiary)]">—</span>
                    )}
                  </span>
                  <span className="text-right">
                    {s?.score !== null && s?.score !== undefined ? s.score.toFixed(2) : "—"}
                  </span>
                  <span className="text-right">{s?.volume ?? "—"}</span>
                  <span className="text-right">{s?.difficulty ?? "—"}</span>
                  <span className="text-right">{s?.appStoreRank ?? "—"}</span>
                  <span className="text-right">{s?.maxReachChance ?? "—"}</span>
                  <div className="flex justify-end gap-1">
                    {k.status !== "ARCHIVED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          handleStatusChange(k, k.status === "ACTIVE" ? "PAUSED" : "ACTIVE")
                        }
                        className="rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] px-2 py-1 text-[10px] tracking-[0.06em] uppercase hover:border-[var(--ink-primary)] disabled:opacity-50"
                      >
                        {k.status === "ACTIVE" ? "Pause" : "Resume"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDelete(k)}
                      className="rounded-[var(--radius)] border-[0.5px] border-[var(--stroke-default)] px-2 py-1 text-[10px] tracking-[0.06em] text-[var(--ink-secondary)] uppercase hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <SuggestKeywordsSheet
        appId={appId}
        open={suggestOpen}
        onClose={() => setSuggestOpen(false)}
      />
    </div>
  );
}

function shortSource(source: string): string {
  switch (source) {
    case "AI_SUGGESTED":
      return "AI";
    case "APPLE_RECOMMENDED":
      return "APPLE";
    case "COMPETITOR_BORROWED":
      return "COMP";
    case "ASTRO_CSV":
      return "ASTRO";
    default:
      return source;
  }
}

function bucketVariant(bucket: string): "default" | "success" | "warning" | "danger" {
  switch (bucket) {
    case "CHAMPION":
      return "success";
    case "OPPORTUNITY":
    case "RISING":
      return "warning";
    case "DECAY":
      return "danger";
    default:
      return "default";
  }
}
