"use client";
import { useState } from "react";
import { FileUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button, Spinner, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import type { PreviewRow } from "./PreviewsPanel";

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
  locale: string;
  previewType: string;
  currentCount: number;
  onUploaded: (uploaded: PreviewRow) => void;
}

interface QueueItem {
  file: File;
  status: "pending" | "uploading" | "done" | "failed";
  message?: string;
  progress?: number;
  result?: PreviewRow;
}

const ACCEPT = "video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v";
const MAX_BYTES = 500 * 1024 * 1024;

export function VideoUploadDialog(props: Props): JSX.Element {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);

  function reset(): void {
    setQueue([]);
    setDragOver(false);
  }
  function close(): void {
    if (running) return;
    reset();
    props.onClose();
  }

  function addFiles(files: FileList | File[]): void {
    const space = Math.max(0, 3 - props.currentCount - queue.filter((q) => q.status !== "failed").length);
    const arr: QueueItem[] = [];
    for (const f of files) {
      if (arr.length >= space) {
        arr.push({ file: f, status: "failed", message: "Slot full (max 3 per device per locale)" });
        continue;
      }
      if (f.size > MAX_BYTES) {
        arr.push({
          file: f,
          status: "failed",
          message: `Too large (${(f.size / 1024 / 1024).toFixed(1)} MB, max 500 MB)`,
        });
        continue;
      }
      const ext = f.name.toLowerCase().split(".").pop() ?? "";
      if (!["mp4", "mov", "m4v"].includes(ext)) {
        arr.push({ file: f, status: "failed", message: `Unsupported extension .${ext}` });
        continue;
      }
      arr.push({ file: f, status: "pending" });
    }
    setQueue((q) => [...q, ...arr]);
  }

  async function uploadOne(item: QueueItem, ordinal: number): Promise<QueueItem> {
    const csrfRes = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
    const csrf = (await csrfRes.json()) as { csrfToken: string };

    const fd = new FormData();
    fd.append("file", item.file);
    fd.append("locale", props.locale);
    fd.append("previewType", props.previewType);
    fd.append("ordinal", String(ordinal));

    const res = await fetch(`/api/v1/apps/${props.appId}/previews/upload`, {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { "x-csrf-token": csrf.csrfToken },
    });
    const data = (await res.json().catch(() => null)) as
      | { preview?: { id: string; state: string; ordinal: number; storageKey: string } }
      | { error?: { message?: string } }
      | null;
    if (!res.ok) {
      const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status.toString()}`;
      return { ...item, status: "failed", message };
    }
    const pv = (data as { preview: { id: string; state: string; ordinal: number; storageKey: string } }).preview;
    return {
      ...item,
      status: "done",
      result: {
        id: pv.id,
        locale: props.locale,
        previewType: props.previewType,
        fileName: item.file.name,
        ordinal: pv.ordinal,
        state: pv.state,
        storageKey: pv.storageKey,
        thumbnailKey: null,
        upstreamVideoUrl: null,
        upstreamPosterUrl: null,
        mimeType: item.file.type,
        fileSize: item.file.size,
      },
    };
  }

  async function uploadAll(): Promise<void> {
    setRunning(true);
    let ordinal = props.currentCount + 1;
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i]!;
      if (item.status !== "pending") continue;
      setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "uploading" } : x)));
      const out = await uploadOne(item, ordinal);
      setQueue((q) => q.map((x, j) => (j === i ? out : x)));
      if (out.status === "done") {
        ordinal += 1;
        if (out.result) props.onUploaded(out.result);
      }
    }
    setRunning(false);
  }

  const counts = {
    pending: queue.filter((q) => q.status === "pending").length,
    done: queue.filter((q) => q.status === "done").length,
    failed: queue.filter((q) => q.status === "failed").length,
  };

  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="Upload app previews"
      subtitle={`${props.previewType} · ${props.locale} · ${(3 - props.currentCount).toString()} slot${
        3 - props.currentCount === 1 ? "" : "s"
      } left`}
      width={640}
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
            if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
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
            Drop .mp4 / .mov / .m4v files or{" "}
            <label className="cursor-pointer underline">
              browse
              <input
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </p>
          <p className="font-mono text-[10px] text-[var(--ink-tertiary)]">
            Max 500 MB · we sniff the ftyp marker before uploading
          </p>
        </div>

        {queue.length > 0 && (
          <ul className="max-h-[300px] divide-y divide-[var(--stroke-default)] overflow-y-auto rounded-[var(--radius-xs)] border border-[var(--stroke-default)]">
            {queue.map((item, idx) => (
              <li
                key={`${item.file.name}-${idx.toString()}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                  {(idx + 1).toString().padStart(2, "0")}
                </span>
                <span className="flex-1 truncate font-body text-[13px]">{item.file.name}</span>
                <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                  {(item.file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                {item.status === "uploading" && <Spinner size={10} />}
                {item.status === "done" && (
                  <CheckCircle2 size={14} className="text-[var(--status-success)]" />
                )}
                {item.status === "failed" && (
                  <span className="flex items-center gap-1 text-[10px] text-[var(--status-danger)]">
                    <AlertTriangle size={11} />
                    <span className="max-w-[180px] truncate">{item.message ?? "failed"}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">
            {queue.length} queued · {counts.done} done · {counts.failed} failed
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close} disabled={running}>
              {counts.done > 0 ? "Done" : "Cancel"}
            </Button>
            <Button
              variant="primary"
              onClick={() => void uploadAll()}
              disabled={queue.length === 0 || counts.pending === 0 || running}
            >
              {running ? <Spinner size={12} /> : `Upload ${counts.pending.toString()}`}
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
