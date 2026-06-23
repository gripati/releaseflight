"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Edit2, X } from "lucide-react";
import { Input, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";

interface Props {
  credentialId: string;
  initial: string | null;
}

export function AppleVendorNumberEditor({ credentialId, initial }: Props): JSX.Element {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [editing, setEditing] = useState(initial === null);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    const cleaned = value.trim();
    if (cleaned.length > 0 && !/^\d{6,12}$/.test(cleaned)) {
      toast.error("Vendor number must be 6-12 digits");
      return;
    }
    setSaving(true);
    const res = await api(`/api/v1/credentials/${credentialId}`, {
      method: "PATCH",
      body: { appleVendorNumber: cleaned },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Could not save", { description: res.message });
      return;
    }
    toast.success(
      cleaned.length === 0 ? "Vendor number cleared" : "Vendor number saved",
      {
        description: cleaned
          ? "Sales and Trends Reports will sync on the next analytics sync."
          : undefined,
      },
    );
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px]">{initial ?? <em className="text-[var(--ink-tertiary)]">not set</em>}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]"
        >
          <Edit2 size={9} className="inline" /> Edit
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
        placeholder="e.g. 87654321"
        className="h-7 w-40 font-mono text-[11px]"
        maxLength={12}
        disabled={saving}
        autoFocus
      />
      <button
        type="button"
        onClick={save}
        disabled={saving}
        aria-label="Save"
        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] hover:border-[var(--status-success)] hover:text-[var(--status-success)] disabled:opacity-50"
      >
        {saving ? <Spinner size={11} /> : <Check size={11} />}
      </button>
      <button
        type="button"
        onClick={() => {
          setValue(initial ?? "");
          setEditing(false);
        }}
        disabled={saving}
        aria-label="Cancel"
        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] border-[0.5px] border-[var(--stroke-default)] hover:border-[var(--ink-primary)]"
      >
        <X size={11} />
      </button>
    </div>
  );
}
