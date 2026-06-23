"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderArchive, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button, Spinner, Stamp, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";

interface FileResult {
  path: string;
  locale: string;
  displayType: string;
  status: "ok" | "skipped" | "failed";
  message?: string;
}

interface ApiResult {
  ok: number;
  failed: number;
  skipped: number;
  results: FileResult[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
}

export function BulkImportSheet({ open, onClose, appId }: Props): JSX.Element {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setFile(null);
    setDragOver(false);
    setResult(null);
    setError(null);
  }
  function close(): void {
    if (running) return;
    reset();
    onClose();
  }

  function pickFile(f: File): void {
    setError(null);
    setResult(null);
    if (!f.name.toLowerCase().endsWith(".zip")) {
      setError("Pick a .zip file containing <locale>/<displayType>/*.png|jpg");
      return;
    }
    setFile(f);
  }

  async function run(): Promise<void> {
    if (!file) return;
    setRunning(true);
    setError(null);
    try {
      const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
      const csrf = (await csrfRes.json()) as { csrfToken: string };
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/apps/${appId}/screenshots/bulk-import-zip`, {
        method: "POST",
        credentials: "include",
        body: fd,
        headers: { "x-csrf-token": csrf.csrfToken },
      });
      const data = (await res.json().catch(() => null)) as
        | ApiResult
        | { error?: { message?: string } }
        | null;
      if (!res.ok) {
        const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status.toString()}`;
        setError(message);
        return;
      }
      setResult(data as ApiResult);
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Bulk import from ZIP"
      subtitle="Expected layout: <locale>/<displayType>/<NN>.png"
      width={680}
    >
      <div className="space-y-5">
        {!result && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) pickFile(f);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border-[1.5px] border-dashed px-6 py-10 text-center transition-colors",
              dragOver
                ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                : "border-[var(--stroke-default)] bg-[var(--surface-sunken)]",
            )}
          >
            <FolderArchive size={20} className="text-[var(--ink-tertiary)]" />
            <p className="font-body text-[13px] text-[var(--ink-secondary)]">
              Drop a .zip file or{" "}
              <label className="cursor-pointer underline">
                browse
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) pickFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </p>
            {file && (
              <p className="font-mono text-[11px] text-[var(--ink-primary)]">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
            <p className="font-mono text-[10px] text-[var(--ink-tertiary)]">
              Up to 500 MB · 500 files · png/jpg
            </p>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
          >
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-[var(--radius)] bg-[var(--surface-sunken)] p-4">
            <header className="mb-3 flex items-center gap-2">
              {result.failed === 0 ? (
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
            <dl className="mb-4 grid grid-cols-3 gap-4 font-mono text-[12px]">
              <div>
                <dt className="text-[var(--ink-tertiary)] uppercase tracking-[0.08em]">Uploaded</dt>
                <dd className="font-display text-2xl">{result.ok}</dd>
              </div>
              <div>
                <dt className="text-[var(--ink-tertiary)] uppercase tracking-[0.08em]">Skipped</dt>
                <dd className="font-display text-2xl">{result.skipped}</dd>
              </div>
              <div>
                <dt className="text-[var(--ink-tertiary)] uppercase tracking-[0.08em]">Failed</dt>
                <dd className="font-display text-2xl text-[var(--status-danger)]">{result.failed}</dd>
              </div>
            </dl>
            <details className="text-[11px]">
              <summary className="cursor-pointer font-mono uppercase tracking-[0.08em] text-[var(--ink-secondary)]">
                Per-file detail
              </summary>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono">
                {result.results.map((r) => (
                  <li key={r.path} className="flex items-start gap-2">
                    <Stamp
                      variant={r.status === "ok" ? "success" : r.status === "skipped" ? "warning" : "danger"}
                    >
                      {r.status.toUpperCase()}
                    </Stamp>
                    <span className="flex-1 break-all">{r.path}</span>
                    {r.message && <span className="text-[var(--ink-tertiary)]">{r.message}</span>}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <Button variant="ghost" onClick={close} disabled={running}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button variant="primary" onClick={() => void run()} disabled={!file || running}>
              {running ? <Spinner size={12} /> : "Import"}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
