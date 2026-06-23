"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button, Checkbox, Spinner, Stamp, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";

interface Summary {
  parsedLocales: number;
  created: string[];
  matched: string[];
  skipped: { locale: string; reason: string }[];
  failed: { locale: string; reason: string }[];
  truncated: { locale: string; field: string; fromLen: number; toLen: number }[];
  unsupportedGooglePlay: string[];
}

interface Props {
  appId: string;
  open: boolean;
  onClose: () => void;
}

export function ImportMasterJsonSheet({ appId, open, onClose }: Props): JSX.Element {
  const router = useRouter();
  const [content, setContent] = useState<string>("");
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [truncate, setTruncate] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Summary | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset(): void {
    setContent("");
    setFileLabel(null);
    setError(null);
    setPreview(null);
  }
  function close(): void {
    reset();
    onClose();
  }

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setPreview(null);
    const text = await file.text();
    try {
      JSON.parse(text);
    } catch {
      setError("Selected file is not valid JSON");
      return;
    }
    setContent(text);
    setFileLabel(`${file.name} · ${(file.size / 1024).toFixed(1)} KB`);
  }

  function run(dryRun: boolean): void {
    setError(null);
    startTransition(() => {
      void (async () => {
        const res = await api<{ summary: Summary }>(`/api/v1/apps/${appId}/metadata/import-master-json`, {
          method: "POST",
          body: { json: content, truncateToLimits: truncate, onlyNewLocales: onlyNew, dryRun },
        });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setPreview(res.data.summary);
        if (!dryRun) router.refresh();
      })();
    });
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Import master JSON"
      subtitle="Multi-locale source of truth in one shot"
      width={620}
    >
      <div className="space-y-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-[1.5px] border-dashed px-6 py-10 text-center transition-colors",
            dragOver
              ? "border-[var(--signal)] bg-[var(--signal-tint)]"
              : "border-[var(--stroke-default)] bg-[var(--surface-sunken)]",
          )}
        >
          <FileUp size={20} className="text-[var(--ink-tertiary)]" />
          <p className="font-body text-[13px] text-[var(--ink-secondary)]">
            Drop JSON file or{" "}
            <label className="cursor-pointer underline">
              browse
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </label>
          </p>
          {fileLabel && (
            <p className="font-mono text-[11px] text-[var(--ink-primary)]">{fileLabel}</p>
          )}
        </div>

        <fieldset className="space-y-2">
          <Checkbox
            checked={truncate}
            onChange={(e) => setTruncate(e.target.checked)}
            label="Auto-truncate fields over platform limits"
          />
          <Checkbox
            checked={onlyNew}
            onChange={(e) => setOnlyNew(e.target.checked)}
            label="Only new locales (skip existing)"
          />
        </fieldset>

        {error && (
          <p
            role="alert"
            className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
          >
            {error}
          </p>
        )}

        {preview && (
          <div className="rounded-[var(--radius)] bg-[var(--surface-sunken)] p-4">
            <header className="mb-2 flex items-center gap-2">
              {preview.failed.length === 0 ? (
                <CheckCircle2 size={16} className="text-[var(--status-success)]" />
              ) : (
                <AlertTriangle size={16} className="text-[var(--status-warning)]" />
              )}
              <span
                className="font-display text-base"
                style={{ fontVariationSettings: "'wght' 500" }}
              >
                Summary
              </span>
            </header>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-body text-[12px]">
              <dt className="text-[var(--ink-tertiary)]">Parsed locales</dt>
              <dd>{preview.parsedLocales}</dd>
              <dt className="text-[var(--ink-tertiary)]">Created</dt>
              <dd>{preview.created.length}</dd>
              <dt className="text-[var(--ink-tertiary)]">Matched</dt>
              <dd>{preview.matched.length}</dd>
              <dt className="text-[var(--ink-tertiary)]">Truncated</dt>
              <dd>{preview.truncated.length}</dd>
              <dt className="text-[var(--ink-tertiary)]">Skipped</dt>
              <dd>{preview.skipped.length}</dd>
              <dt className="text-[var(--ink-tertiary)]">Failed</dt>
              <dd>{preview.failed.length}</dd>
              {preview.unsupportedGooglePlay.length > 0 && (
                <>
                  <dt className="text-[var(--ink-tertiary)]">Unsupported (Google)</dt>
                  <dd>{preview.unsupportedGooglePlay.join(", ")}</dd>
                </>
              )}
            </dl>
            {preview.failed.length > 0 && (
              <details className="mt-3 text-[11px]">
                <summary className="cursor-pointer font-mono uppercase tracking-[0.08em] text-[var(--status-danger)]">
                  Failures
                </summary>
                <ul className="mt-2 space-y-1 font-mono">
                  {preview.failed.map((f) => (
                    <li key={`${f.locale}-${f.reason}`}>
                      <Stamp variant="danger">{f.locale}</Stamp> {f.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => run(true)}
            disabled={!content || isPending}
          >
            {isPending ? <Spinner size={12} /> : "Preview"}
          </Button>
          <Button
            variant="primary"
            onClick={() => run(false)}
            disabled={!content || isPending}
          >
            {isPending ? <Spinner size={12} /> : "Import →"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
