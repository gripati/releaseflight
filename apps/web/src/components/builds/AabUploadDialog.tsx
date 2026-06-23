"use client";
import { useState } from "react";
import { FileUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button, Spinner, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { toast } from "@/components/feedback/Toaster";

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
  onUploaded: () => void;
}

const MAX_BYTES = 500 * 1024 * 1024;

export function AabUploadDialog({ open, onClose, appId, onUploaded }: Props): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ versionCode: number; sha256: string } | null>(null);

  function pick(f: File): void {
    setError(null);
    if (!f.name.toLowerCase().endsWith(".aab")) {
      setError("Pick a .aab file (Android App Bundle)");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`Too large (${(f.size / 1024 / 1024).toFixed(1)} MB) — max 500 MB`);
      return;
    }
    setFile(f);
  }

  function close(): void {
    if (running) return;
    setFile(null);
    setError(null);
    setResult(null);
    onClose();
  }

  async function upload(): Promise<void> {
    if (!file) return;
    setRunning(true);
    setError(null);
    try {
      const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
      const csrf = (await csrfRes.json()) as { csrfToken: string };
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/apps/${appId}/builds/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
        headers: { "x-csrf-token": csrf.csrfToken },
      });
      const data = (await res.json().catch(() => null)) as
        | { versionCode?: number; sha256?: string }
        | { error?: { message?: string } }
        | null;
      if (!res.ok) {
        const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status.toString()}`;
        setError(message);
        toast.error(`AAB upload failed: ${message}`);
        return;
      }
      const ok = data as { versionCode: number; sha256: string };
      setResult(ok);
      toast.success(`AAB uploaded · versionCode ${ok.versionCode.toString()}`);
      onUploaded();
    } finally {
      setRunning(false);
    }
  }

  return (
    <Sheet open={open} onClose={close} title="Upload AAB" subtitle="Google Play Android App Bundle · max 500 MB" width={620}>
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
              if (f) pick(f);
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
              Drop .aab file or{" "}
              <label className="cursor-pointer underline">
                browse
                <input
                  type="file"
                  accept=".aab,application/octet-stream"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) pick(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </p>
            {file && (
              <p className="font-mono text-[11px] text-[var(--ink-primary)]">
                {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]">
            <AlertTriangle size={12} className="mr-1 inline" />
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-[var(--radius)] bg-[var(--status-success-tint)] p-6 text-center">
            <CheckCircle2 size={28} className="mx-auto text-[var(--status-success)]" />
            <h4 className="mt-3 font-display text-xl">Upload complete</h4>
            <p className="mt-2 font-mono text-[11px] text-[var(--ink-secondary)]">
              versionCode {result.versionCode} · sha256 {result.sha256.slice(0, 16)}…
            </p>
            <p className="mt-3 font-body text-[12px] text-[var(--ink-secondary)]">
              Assign this bundle to internal / alpha / beta / production on the next screen.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <Button variant="ghost" onClick={close} disabled={running}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button variant="primary" onClick={() => void upload()} disabled={!file || running}>
              {running ? <Spinner size={12} /> : "Upload"}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
