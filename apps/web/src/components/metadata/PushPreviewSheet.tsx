"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Rocket } from "lucide-react";
import { Button, Spinner, Stamp, cn, localeName } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { api } from "@/lib/apiClient";

interface FieldDiff {
  field: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

interface LocaleDiff {
  canonicalLocale: string;
  changes: FieldDiff[];
  unsupportedOnGoogle: boolean;
  notes: string[];
}

interface DiffResponse {
  app: { id: string; platform: "IOS" | "ANDROID" };
  locales: LocaleDiff[];
  totals: { locales: number; fields: number; unsupportedOnGoogle: number };
}

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
}

export function PushPreviewSheet({ open, onClose, appId }: Props): JSX.Element {
  const router = useRouter();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pushing, startPush] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void (async () => {
      const res = await api<DiffResponse>(`/api/v1/apps/${appId}/metadata/diff`, {
        method: "POST",
        body: { dirtyOnly: true },
      });
      setLoading(false);
      if (res.ok) setData(res.data);
      else setError(res.message);
    })();
  }, [appId, open]);

  function confirm(): void {
    startPush(() => {
      void (async () => {
        const res = await api(`/api/v1/apps/${appId}/metadata/push`, {
          method: "POST",
          body: { includeVersionSettings: true },
        });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        onClose();
        router.refresh();
      })();
    });
  }

  return (
    <Sheet open={open} onClose={onClose} title="Preview push" subtitle="Word-level diff per locale" width={720}>
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size={16} />
        </div>
      ) : !data ? (
        <p className="font-body text-[13px] text-[var(--ink-tertiary)]">{error ?? "No data"}</p>
      ) : data.locales.length === 0 ? (
        <p className="font-body text-[13px] text-[var(--ink-tertiary)]">
          No unpushed changes — already in sync.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            {data.totals.locales} locale{data.totals.locales === 1 ? "" : "s"} ·{" "}
            {data.totals.fields} field change{data.totals.fields === 1 ? "" : "s"}
            {data.totals.unsupportedOnGoogle > 0
              ? ` · ${data.totals.unsupportedOnGoogle.toString()} unsupported on Google`
              : ""}
          </p>
          <ul className="space-y-3">
            {data.locales.map((loc) => (
              <li
                key={loc.canonicalLocale}
                className="rounded-[var(--radius)] border border-[var(--stroke-default)] p-4"
              >
                <header className="mb-3 flex items-center gap-3">
                  <span
                    className="font-display text-lg leading-none"
                    style={{ fontVariationSettings: "'wght' 500" }}
                  >
                    {loc.canonicalLocale}
                  </span>
                  <span className="font-body text-[12px] text-[var(--ink-secondary)]">
                    {localeName(loc.canonicalLocale)}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-[var(--ink-tertiary)]">
                    {loc.changes.filter((c) => c.changed).length} fields
                  </span>
                  {loc.unsupportedOnGoogle && <Stamp variant="warning">UNSUPPORTED</Stamp>}
                </header>
                {loc.notes.map((n) => (
                  <p
                    key={n}
                    className="mb-2 flex items-center gap-1 font-body text-[11px] text-[var(--status-warning)]"
                  >
                    <AlertTriangle size={10} /> {n}
                  </p>
                ))}
                <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  {loc.changes
                    .filter((c) => c.changed)
                    .map((c) => (
                      <FieldRow key={c.field} field={c.field} after={c.after} />
                    ))}
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2 font-body text-[12px] text-[var(--status-danger)]"
        >
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pushing}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={confirm}
          disabled={pushing || !data || data.locales.length === 0}
        >
          {pushing ? <Spinner size={12} /> : <Rocket size={14} />} Confirm push
        </Button>
      </div>
    </Sheet>
  );
}

function FieldRow({ field, after }: { field: string; after: string | null }): JSX.Element {
  const truncated = after && after.length > 200 ? `${after.slice(0, 200)}…` : after;
  return (
    <>
      <dt className="text-[var(--ink-tertiary)] uppercase tracking-[0.08em]">{field}</dt>
      <dd className={cn(after ? "" : "text-[var(--ink-tertiary)] italic")}>
        {truncated ?? "(empty)"}
      </dd>
    </>
  );
}
