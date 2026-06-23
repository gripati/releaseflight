"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud, FileVideo, Play, Plus, Trash2 } from "lucide-react";
import { Button, Spinner, Stamp, StateDot, cn, localeName } from "@marquee/ui";
import { LocaleStrip } from "@/components/shell/LocaleStrip";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { VideoUploadDialog } from "./VideoUploadDialog";
import { VideoLightbox } from "./VideoLightbox";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

export interface PreviewRow {
  id: string;
  locale: string;
  previewType: string;
  fileName: string;
  ordinal: number;
  state: string;
  storageKey: string | null;
  thumbnailKey: string | null;
  upstreamVideoUrl: string | null;
  upstreamPosterUrl: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

interface Props {
  appId: string;
  primaryLocale: string;
  availableLanguages: string[];
  discoveredTypes: string[];
  initialPreviews: PreviewRow[];
}

const DEFAULT_TYPES = ["IPHONE_67", "IPHONE_65", "IPAD_PRO_3GEN_129"];

/**
 * Asset URL resolution — CDN-direct first (mirrors ScreenshotsPanel).
 *
 * Apple App Preview rows carry `upstreamVideoUrl` + `upstreamPosterUrl`
 * with short-lived presigned URLs. When present the browser plays the
 * mp4 / loads the poster directly from Apple's CDN — no server bytes
 * touched. Local `storageKey` is a fallback for user-uploaded previews
 * that haven't been pushed to the store yet.
 */
function videoUrl(p: PreviewRow): string {
  if (p.upstreamVideoUrl) return p.upstreamVideoUrl;
  if (p.storageKey) return `/api/v1/storage/${p.storageKey}`;
  return "";
}

function posterUrl(p: PreviewRow): string {
  if (p.upstreamPosterUrl) return p.upstreamPosterUrl;
  if (p.thumbnailKey) return `/api/v1/storage/${p.thumbnailKey}`;
  return "";
}

export function PreviewsPanel(props: Props): JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<PreviewRow[]>(props.initialPreviews);

  // Default selectors should land on slots that ACTUALLY have data —
  // see ScreenshotsPanel for the rationale.
  function pickInitialLocale(): string {
    const localesWithData = new Set(props.initialPreviews.map((p) => p.locale));
    if (localesWithData.has(props.primaryLocale)) return props.primaryLocale;
    const firstWithData = props.availableLanguages.find((l) => localesWithData.has(l));
    return firstWithData ?? props.primaryLocale ?? props.availableLanguages[0] ?? "en-US";
  }
  function pickInitialType(): string {
    const typesWithData = new Set(
      props.initialPreviews.map((p) => p.previewType).filter(Boolean),
    );
    const firstDiscoveredWithData = props.discoveredTypes.find((t) =>
      typesWithData.has(t),
    );
    if (firstDiscoveredWithData) return firstDiscoveredWithData;
    return props.discoveredTypes[0] ?? "IPHONE_65";
  }
  const [locale, setLocale] = useState<string>(pickInitialLocale);
  const [previewType, setPreviewType] = useState<string>(pickInitialType);

  const [openUpload, setOpenUpload] = useState(false);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [fetching, startFetch] = useTransition();
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Reconcile local state when server re-renders with new initial data.
  // Also nudge selectors to the first slot with data so the user sees
  // results immediately after a Pull-from-store.
  useEffect(() => {
    setRows(props.initialPreviews);
    const localesWithData = new Set(props.initialPreviews.map((p) => p.locale));
    if (localesWithData.size > 0 && !localesWithData.has(locale)) {
      const next = props.availableLanguages.find((l) => localesWithData.has(l));
      if (next) setLocale(next);
    }
    const typesForLocale = new Set(
      props.initialPreviews
        .filter((p) => p.locale === locale || localesWithData.has(locale))
        .map((p) => p.previewType)
        .filter(Boolean),
    );
    if (typesForLocale.size > 0 && !typesForLocale.has(previewType)) {
      const nextType = props.discoveredTypes.find((t) => typesForLocale.has(t));
      if (nextType) setPreviewType(nextType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialPreviews]);

  const typeOptions = useMemo(
    () => [...new Set([...props.discoveredTypes, ...DEFAULT_TYPES])],
    [props.discoveredTypes],
  );

  const localeOptions = useMemo(() => {
    if (props.availableLanguages.length > 0) return props.availableLanguages;
    return [props.primaryLocale];
  }, [props.availableLanguages, props.primaryLocale]);

  const filtered = useMemo(
    () =>
      rows
        .filter((r) => r.locale === locale && r.previewType === previewType)
        .sort((a, b) => a.ordinal - b.ordinal),
    [rows, locale, previewType],
  );

  const lightboxItem = lightboxId ? rows.find((r) => r.id === lightboxId) : null;

  function pullFromStore(): void {
    startFetch(() => {
      void (async () => {
        const t = toast.loading("Fetching previews…", {
          description: "Reading App Preview videos from the store",
        });
        const res = await api<{ count: number; previewTypes?: string[] }>(
          `/api/v1/apps/${props.appId}/previews/fetch`,
          { method: "POST" },
        );
        if (!res.ok) {
          toast.error("Fetch failed", { id: t, description: res.message });
          return;
        }
        toast.success(
          res.data.count === 0
            ? "No previews on the store yet"
            : `${res.data.count.toString()} preview${res.data.count === 1 ? "" : "s"} indexed`,
          {
            id: t,
            description:
              res.data.count === 0
                ? "Upload a trailer video above."
                : `${(res.data.previewTypes ?? []).length.toString()} device type${(res.data.previewTypes ?? []).length === 1 ? "" : "s"} discovered.`,
          },
        );
        router.refresh();
      })();
    });
  }

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function doDelete(id: string): Promise<void> {
    setDeletingId(id);
    setBusy((b) => new Set(b).add(id));
    const res = await api(`/api/v1/apps/${props.appId}/previews/${id}`, { method: "DELETE" });
    setBusy((b) => {
      const next = new Set(b);
      next.delete(id);
      return next;
    });
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!res.ok) {
      toast.error("Delete failed", { description: res.message });
      return;
    }
    toast.success("Preview deleted");
    setRows((r) => r.filter((x) => x.id !== id));
    router.refresh();
  }

  function deleteOne(id: string): void {
    setConfirmDeleteId(id);
  }

  function onUploadComplete(row: PreviewRow): void {
    setRows((r) => [...r.filter((x) => x.id !== row.id), row]);
    router.refresh();
  }

  return (
    <div className="page-loaded space-y-4">
      <LocaleStrip
        entries={localeOptions.map((l) => ({ locale: l }))}
        selected={locale}
        onSelect={(loc) => {
          if (loc) setLocale(loc);
        }}
      />

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
              {localeName(locale)} · {filtered.length} preview
              {filtered.length === 1 ? "" : "s"}
            </p>
            <h2
              className="mt-1 font-display text-2xl tracking-[-0.01em]"
              style={{ fontVariationSettings: "'wght' 500" }}
            >
              App Previews
            </h2>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={pullFromStore} disabled={fetching}>
              {fetching ? <Spinner size={12} /> : <DownloadCloud size={14} />} Pull from store
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => setOpenUpload(true)}
              disabled={filtered.length >= 3}
              title={filtered.length >= 3 ? "Apple allows 3 previews per slot" : ""}
            >
              <Plus size={14} /> Upload video
            </Button>
          </div>
        </div>

        <nav
          aria-label="Device preview type"
          className="mb-4 flex flex-wrap items-center gap-1 border-b-[0.5px] border-[var(--stroke-default)] pb-2"
        >
          {typeOptions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setPreviewType(t)}
              className={cn(
                "rounded-[var(--radius-xs)] px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.04em] transition-colors",
                t === previewType
                  ? "bg-[var(--signal-tint)] text-[var(--ink-primary)] ring-[1.5px] ring-[var(--signal)]"
                  : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
              )}
            >
              {t}
            </button>
          ))}
        </nav>

        {filtered.length === 0 ? (
          <EmptyState onUpload={() => setOpenUpload(true)} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((p) => (
              <li key={p.id}>
                <PreviewCard
                  p={p}
                  busy={busy.has(p.id)}
                  onPlay={() => setLightboxId(p.id)}
                  onDelete={() => void deleteOne(p.id)}
                />
              </li>
            ))}
          </ul>
        )}

        <VideoUploadDialog
          open={openUpload}
          onClose={() => setOpenUpload(false)}
          appId={props.appId}
          locale={locale}
          previewType={previewType}
          currentCount={filtered.length}
          onUploaded={onUploadComplete}
        />

        {lightboxItem && (
          <VideoLightbox
            src={videoUrl(lightboxItem)}
            poster={posterUrl(lightboxItem)}
            fileName={lightboxItem.fileName}
            mimeType={lightboxItem.mimeType ?? "video/mp4"}
            meta={`${
              lightboxItem.fileSize ? `${(lightboxItem.fileSize / 1024 / 1024).toFixed(1)} MB` : "—"
            } · ${lightboxItem.state}`}
            onClose={() => setLightboxId(null)}
          />
        )}
      </section>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onClose={() => !deletingId && setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) void doDelete(confirmDeleteId);
        }}
        title="Delete this preview?"
        description="The video is removed locally and from Apple App Preview upstream."
        confirmLabel="Delete"
        pending={deletingId !== null}
      />
    </div>
  );
}

function PreviewCard({
  p,
  busy,
  onPlay,
  onDelete,
}: {
  p: PreviewRow;
  busy: boolean;
  onPlay: () => void;
  onDelete: () => void;
}): JSX.Element {
  const poster = posterUrl(p);
  const state = p.state === "COMPLETE" ? "synced" : p.state === "UPLOAD_FAILED" ? "error" : "syncing";
  return (
    <div className="group relative overflow-hidden rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
      <button
        type="button"
        onClick={onPlay}
        className="relative block aspect-[9/16] w-full overflow-hidden bg-[var(--ink-primary)]"
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={p.fileName}
            className="h-full w-full object-cover opacity-90 transition-opacity duration-[260ms] group-hover:opacity-100"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--surface-paper)]/40">
            <FileVideo size={28} />
          </div>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-[var(--ink-primary)]/30 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--surface-paper)]/90 text-[var(--ink-primary)]">
            <Play size={20} className="ml-0.5" />
          </span>
        </span>
      </button>
      <div className="flex items-center justify-between border-t-[0.5px] border-[var(--stroke-default)] px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--ink-secondary)]">
          <StateDot state={state} />
          {p.ordinal.toString().padStart(2, "0")} ·{" "}
          {p.fileSize ? `${(p.fileSize / 1024 / 1024).toFixed(1)} MB` : "—"}
        </span>
        <div className="flex items-center gap-1">
          {busy ? (
            <Spinner size={10} />
          ) : (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete preview"
              className="rounded-[var(--radius-xs)] p-1 text-[var(--ink-tertiary)] hover:bg-[var(--status-danger-tint)] hover:text-[var(--status-danger)]"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
      {p.state !== "COMPLETE" && (
        <Stamp
          variant={p.state === "UPLOAD_FAILED" ? "danger" : "info"}
          className="absolute left-2 top-2"
        >
          {p.state}
        </Stamp>
      )}
    </div>
  );
}

function EmptyState({ onUpload }: { onUpload: () => void }): JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-sunken)] p-12 text-center">
      <FileVideo size={32} className="mx-auto text-[var(--ink-quaternary)]" />
      <h3
        className="mt-4 font-display text-xl"
        style={{ fontVariationSettings: "'wght' 500" }}
      >
        No previews uploaded yet
      </h3>
      <p className="mx-auto mt-2 max-w-md font-body text-[13px] text-[var(--ink-secondary)]">
        Apple accepts up to 3 video previews per device per locale. Drop your .mp4
        / .mov / .m4v files and we'll handle the reserve + upload + commit
        protocol.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="primary" size="md" onClick={onUpload}>
          <Plus size={14} /> Upload first preview
        </Button>
      </div>
    </div>
  );
}
