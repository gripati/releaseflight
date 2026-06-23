"use client";
import { useState } from "react";
import { Rocket } from "lucide-react";
import { Button, Input, Label, Spinner, Textarea, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

type TrackName = "internal" | "alpha" | "beta" | "production";
type ReleaseStatus = "draft" | "inProgress" | "completed";

const TRACKS: { id: TrackName; label: string; description: string }[] = [
  { id: "internal", label: "Internal", description: "Up to 100 internal testers" },
  { id: "alpha", label: "Alpha (closed)", description: "Closed group of testers" },
  { id: "beta", label: "Beta (open / closed)", description: "Open or closed beta" },
  { id: "production", label: "Production", description: "Public — staged rollout supported" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
  versionCode: number;
  onAssigned: () => void;
}

export function TrackAssignDialog({
  open,
  onClose,
  appId,
  versionCode,
  onAssigned,
}: Props): JSX.Element {
  const [track, setTrack] = useState<TrackName>("internal");
  const [status, setStatus] = useState<ReleaseStatus>("completed");
  const [userFraction, setUserFraction] = useState<number>(0.1);
  const [notes, setNotes] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    if (running) return;
    setError(null);
    onClose();
  }

  async function submit(): Promise<void> {
    setRunning(true);
    setError(null);
    const payload: {
      versionCodes: number[];
      status: ReleaseStatus;
      userFraction?: number;
      releaseNotes?: { language: string; text: string }[];
    } = {
      versionCodes: [versionCode],
      status,
      ...(status === "inProgress" ? { userFraction } : {}),
      ...(notes
        ? { releaseNotes: [{ language: "en-US", text: notes }] }
        : {}),
    };
    const res = await api<{ ok: boolean; strategy: string | null; message: string }>(
      `/api/v1/apps/${appId}/tracks/${track}`,
      { method: "PUT", body: payload },
    );
    setRunning(false);
    if (!res.ok) {
      setError(res.message);
      toast.error("Track assignment failed", { description: res.message });
      return;
    }
    toast.success(
      `Bundle ${versionCode.toString()} assigned to ${track}`,
      { description: res.data.strategy ? `strategy: ${res.data.strategy}` : undefined },
    );
    onAssigned();
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Assign bundle ${versionCode.toString()}`}
      subtitle="Choose a release track and rollout shape"
      width={620}
    >
      <div className="space-y-5">
        <fieldset>
          <Label>Track</Label>
          <div className="mt-2 grid grid-cols-1 gap-2">
            {TRACKS.map((t) => (
              <label
                key={t.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-xs)] border px-3 py-2.5",
                  track === t.id
                    ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                    : "border-[var(--stroke-default)] hover:bg-[var(--surface-tinted)]",
                )}
              >
                <div>
                  <span className="block font-body text-[13px] font-medium">{t.label}</span>
                  <span className="block font-body text-[11px] text-[var(--ink-secondary)]">{t.description}</span>
                </div>
                <input
                  type="radio"
                  name="track"
                  checked={track === t.id}
                  onChange={() => setTrack(t.id)}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <Label>Release status</Label>
          <div className="mt-2 inline-flex rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-0.5">
            {(["draft", "inProgress", "completed"] as ReleaseStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  "rounded-[var(--radius-xs)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.04em] transition-colors",
                  status === s
                    ? "bg-[var(--surface-tinted)] text-[var(--ink-primary)]"
                    : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          {status === "inProgress" && (
            <div className="mt-3">
              <Label htmlFor="frac">Rollout fraction (0–1)</Label>
              <Input
                id="frac"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={userFraction}
                onChange={(e) => setUserFraction(parseFloat(e.target.value))}
                className="mt-1.5 max-w-[120px] font-mono"
              />
              <p className="mt-1 font-body text-[11px] text-[var(--ink-tertiary)]">
                e.g. 0.1 = 10% staged rollout. Use 1 to release to everyone.
              </p>
            </div>
          )}
        </fieldset>

        <div>
          <Label htmlFor="notes">Release notes (en-US)</Label>
          <Textarea
            id="notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            className="mt-1.5 resize-none"
            placeholder="What's new in this build?"
          />
        </div>

        {error && (
          <p className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t-[0.5px] border-[var(--stroke-default)] pt-4">
          <Button variant="ghost" onClick={close} disabled={running}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={running}>
            {running ? <Spinner size={12} /> : (<><Rocket size={14} /> Assign & commit</>)}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
