"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button, Checkbox, Spinner, Stamp, cn, localeName } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
  sourceLocale: string;
  displayType: string;
  availableLocales: string[];
}

interface PerLocale {
  locale: string;
  copied: number;
  failed: number;
  errors: string[];
}

export function ApplyToLocalesSheet({
  open,
  onClose,
  appId,
  sourceLocale,
  displayType,
  availableLocales,
}: Props): JSX.Element {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [append, setAppend] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ perLocale: PerLocale[]; totalCopied: number; totalFailed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targets = availableLocales.filter((l) => l !== sourceLocale);

  function toggle(l: string): void {
    const next = new Set(selected);
    if (next.has(l)) next.delete(l);
    else next.add(l);
    setSelected(next);
  }

  function close(): void {
    if (running) return;
    setSelected(new Set());
    setResult(null);
    setError(null);
    onClose();
  }

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    const res = await api<{ perLocale: PerLocale[]; totalCopied: number; totalFailed: number }>(
      `/api/v1/apps/${appId}/screenshots/apply-to-locales`,
      {
        method: "POST",
        body: {
          sourceLocale,
          displayType,
          targetLocales: [...selected],
          append,
        },
      },
    );
    setRunning(false);
    if (!res.ok) {
      setError(res.message);
      toast.error("Apply to locales failed", { description: res.message });
      return;
    }
    setResult(res.data);
    toast.success("Applied to locales", {
      description: `${res.data.totalCopied.toString()} screenshot${res.data.totalCopied === 1 ? "" : "s"} created`,
    });
    router.refresh();
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Apply to other locales"
      subtitle={`${sourceLocale} → N locales · ${displayType}`}
      width={620}
    >
      <div className="space-y-5">
        {!result && (
          <>
            <p className="font-body text-[13px] text-[var(--ink-secondary)]">
              Copies the current set of <strong>{displayType}</strong> screenshots from{" "}
              <strong>{sourceLocale}</strong> to the locales you pick below. By default we{" "}
              <em>replace</em> what's already there; tick <em>Append</em> to keep existing
              uploads and add new ones after them.
            </p>

            <fieldset className="rounded-[var(--radius)] border border-[var(--stroke-default)] p-3">
              <legend className="px-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
                Target locales · {selected.size}/{targets.length}
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
                {targets.map((l) => (
                  <label
                    key={l}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-[12px]",
                      selected.has(l)
                        ? "bg-[var(--signal-tint)] text-[var(--ink-primary)]"
                        : "hover:bg-[var(--surface-tinted)] text-[var(--ink-secondary)]",
                    )}
                  >
                    <Checkbox
                      size="sm"
                      checked={selected.has(l)}
                      onChange={() => toggle(l)}
                    />
                    <span className="font-mono text-[11px]">{l}</span>
                    <span className="truncate font-body text-[11px] text-[var(--ink-tertiary)]">
                      {localeName(l)}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(targets))}
                  className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                >
                  Clear
                </button>
              </div>
            </fieldset>

            <Checkbox
              checked={append}
              onChange={(e) => setAppend(e.target.checked)}
              label="Append to existing screenshots (don't replace)"
            />
          </>
        )}

        {error && (
          <p className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]">
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-[var(--radius)] bg-[var(--surface-sunken)] p-4">
            <header className="mb-3 flex items-center gap-2">
              {result.totalFailed === 0 ? (
                <CheckCircle2 size={16} className="text-[var(--status-success)]" />
              ) : (
                <AlertTriangle size={16} className="text-[var(--status-warning)]" />
              )}
              <span
                className="font-display text-base"
                style={{ fontVariationSettings: "'wght' 500" }}
              >
                {result.totalCopied} copied · {result.totalFailed} failed
              </span>
            </header>
            <ul className="space-y-1 font-mono text-[11px]">
              {result.perLocale.map((p) => (
                <li key={p.locale} className="flex items-center gap-2">
                  <Stamp variant={p.failed === 0 ? "success" : p.copied > 0 ? "warning" : "danger"}>
                    {p.locale}
                  </Stamp>
                  <span className="text-[var(--ink-secondary)]">
                    {p.copied} ok · {p.failed} failed
                  </span>
                  {p.errors.length > 0 && (
                    <span className="text-[var(--ink-tertiary)]">— {p.errors.join("; ")}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <Button variant="ghost" onClick={close} disabled={running}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button
              variant="primary"
              onClick={() => void run()}
              disabled={selected.size === 0 || running}
            >
              {running ? <Spinner size={12} /> : (
                <>
                  <Copy size={14} /> Apply to {selected.size.toString()}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
