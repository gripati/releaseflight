"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Copy,
  DownloadCloud,
  FolderArchive,
  ImageIcon,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Spinner, Stamp, StateDot, cn, localeName } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { LocaleStrip } from "@/components/shell/LocaleStrip";
import { UploadDialog } from "./UploadDialog";
import { Lightbox } from "./Lightbox";
import { SortableGrid } from "./SortableGrid";
import { BulkImportSheet } from "./BulkImportSheet";
import { ApplyToLocalesSheet } from "./ApplyToLocalesSheet";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

type Platform = "IOS" | "ANDROID";

export interface ScreenshotRow {
  id: string;
  locale: string;
  displayType: string;
  fileName: string;
  width: number;
  height: number;
  ordinal: number;
  state: string;
  thumbnailKey: string | null;
  storageKey: string | null;
  upstreamUrl: string | null;
  fileSize: number | null;
}

interface Props {
  appId: string;
  platform: Platform;
  primaryLocale: string;
  availableLanguages: string[];
  discoveredTypes: string[];
  initialScreenshots: ScreenshotRow[];
}

const IOS_DEFAULT_TYPES = ["APP_IPHONE_67", "APP_IPHONE_65", "APP_IPAD_PRO_3GEN_129"];
const ANDROID_DEFAULT_TYPES = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "icon",
  "featureGraphic",
];

/**
 * Image URL resolution — CDN-direct first.
 *
 * Apple/Google return short-lived presigned URLs (`assetDeliveryUrl`,
 * `previewImage.url`) when we fetch screenshots. We persist them on the
 * row as `upstreamUrl`. When present, the browser loads the bytes from
 * the store CDN directly — never round-tripping through our server.
 *
 * Fallback order:
 *   1. upstreamUrl  — store CDN, freshest, zero server work
 *   2. thumbnailKey — local server-side resized PNG (256-wide)
 *   3. storageKey   — original local upload
 */
function thumbUrl(s: ScreenshotRow): string {
  if (s.upstreamUrl) return s.upstreamUrl;
  if (s.thumbnailKey) return `/api/v1/storage/${s.thumbnailKey}`;
  if (s.storageKey) return `/api/v1/storage/${s.storageKey}`;
  return "";
}

export function ScreenshotsPanel(props: Props): JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<ScreenshotRow[]>(props.initialScreenshots);

  // Default-locale heuristic: the app's `availableLanguages` is alphabetical
  // and includes 39+ locales for live apps, but only a handful actually
  // have screenshots. Picking [0] (often "cs"/"ar") shows an empty grid
  // and the user thinks the fetch failed. We prefer:
  //   1. primaryLocale (if it has screenshots)
  //   2. the first locale that DOES have screenshots
  //   3. primaryLocale anyway
  //   4. availableLanguages[0]
  function pickInitialLocale(): string {
    const localesWithData = new Set(props.initialScreenshots.map((s) => s.locale));
    if (localesWithData.has(props.primaryLocale)) return props.primaryLocale;
    const firstWithData = props.availableLanguages.find((l) => localesWithData.has(l));
    if (firstWithData) return firstWithData;
    return props.primaryLocale || props.availableLanguages[0] || "en-US";
  }
  const [locale, setLocale] = useState<string>(pickInitialLocale);

  // Default-displayType heuristic: pick the first type that has data,
  // not just the first discovered alphabetically.
  function pickInitialType(): string {
    const typesWithData = new Set(
      props.initialScreenshots.map((s) => s.displayType).filter(Boolean),
    );
    const firstDiscoveredWithData = props.discoveredTypes.find((t) =>
      typesWithData.has(t),
    );
    if (firstDiscoveredWithData) return firstDiscoveredWithData;
    if (props.discoveredTypes.length > 0) return props.discoveredTypes[0]!;
    return props.platform === "IOS" ? "APP_IPHONE_65" : "phoneScreenshots";
  }
  const [displayType, setDisplayType] = useState<string>(pickInitialType);

  const [openUpload, setOpenUpload] = useState(false);
  const [openBulk, setOpenBulk] = useState(false);
  const [openApply, setOpenApply] = useState(false);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [fetching, startFetch] = useTransition();
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Reconcile local state when the server component re-renders with new
  // initial data (e.g. after router.refresh() following a Pull-from-store).
  useEffect(() => {
    setRows(props.initialScreenshots);
    // After a fresh pull, also nudge locale + displayType to the first
    // slot that actually has data, so the user immediately sees results.
    const localesWithData = new Set(props.initialScreenshots.map((s) => s.locale));
    if (localesWithData.size > 0 && !localesWithData.has(locale)) {
      const next = props.availableLanguages.find((l) => localesWithData.has(l));
      if (next) setLocale(next);
    }
    const typesForLocale = new Set(
      props.initialScreenshots
        .filter((s) => s.locale === locale || localesWithData.has(locale))
        .map((s) => s.displayType)
        .filter(Boolean),
    );
    if (typesForLocale.size > 0 && !typesForLocale.has(displayType)) {
      const nextType = props.discoveredTypes.find((t) => typesForLocale.has(t));
      if (nextType) setDisplayType(nextType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialScreenshots]);

  const typeOptions = useMemo(() => {
    const defaults = props.platform === "IOS" ? IOS_DEFAULT_TYPES : ANDROID_DEFAULT_TYPES;
    return [...new Set([...props.discoveredTypes, ...defaults])];
  }, [props.discoveredTypes, props.platform]);

  const localeOptions = useMemo(() => {
    if (props.availableLanguages.length > 0) return props.availableLanguages;
    return [props.primaryLocale];
  }, [props.availableLanguages, props.primaryLocale]);

  const filtered = useMemo(
    () =>
      rows
        .filter((r) => r.locale === locale && r.displayType === displayType)
        .sort((a, b) => a.ordinal - b.ordinal),
    [rows, locale, displayType],
  );

  const lightboxItem = lightboxId ? rows.find((r) => r.id === lightboxId) : null;

  function pullFromStore(): void {
    startFetch(() => {
      void (async () => {
        const t = toast.loading("Fetching screenshots…", {
          description: "Reading every locale + device-size from the store",
        });
        const res = await api<{
          count: number;
          displayTypes?: string[];
          imageTypes?: string[];
        }>(`/api/v1/apps/${props.appId}/screenshots/fetch`, { method: "POST" });
        if (!res.ok) {
          toast.error("Fetch failed", { id: t, description: res.message });
          return;
        }
        const kinds = res.data.displayTypes ?? res.data.imageTypes ?? [];
        toast.success(
          res.data.count === 0
            ? "No screenshots on the store yet"
            : `${res.data.count.toString()} screenshot${res.data.count === 1 ? "" : "s"} indexed`,
          {
            id: t,
            description:
              res.data.count === 0
                ? "Upload your first screenshot above."
                : `${kinds.length.toString()} device type${kinds.length === 1 ? "" : "s"} discovered.`,
          },
        );
        router.refresh();
      })();
    });
  }

  // Two-step destructive: the trash icon arms `confirmDeleteId`, the
  // ConfirmDialog (rendered at the bottom of the panel) fires the actual
  // DELETE. Lets us share one ConfirmDialog for every card without ever
  // calling the native (un-themable) confirm().
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function doDelete(id: string): Promise<void> {
    setDeletingId(id);
    setBusy((b) => new Set(b).add(id));
    const res = await api(`/api/v1/apps/${props.appId}/screenshots/${id}`, { method: "DELETE" });
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
    toast.success("Screenshot deleted");
    setRows((r) => r.filter((x) => x.id !== id));
    router.refresh();
  }
  function deleteOne(id: string): void {
    setConfirmDeleteId(id);
  }

  function onUploadComplete(uploaded: ScreenshotRow): void {
    setRows((r) => [...r.filter((x) => x.id !== uploaded.id), uploaded]);
    router.refresh();
  }

  async function commitReorder(newOrder: string[]): Promise<void> {
    // Optimistic update
    setRows((current) => {
      const orderMap = new Map<string, number>();
      newOrder.forEach((id, idx) => orderMap.set(id, idx + 1));
      return current.map((r) =>
        orderMap.has(r.id) ? { ...r, ordinal: orderMap.get(r.id)! } : r,
      );
    });

    const res = await api(`/api/v1/apps/${props.appId}/screenshots/reorder`, {
      method: "POST",
      body: { locale, displayType, orderedIds: newOrder },
    });
    if (!res.ok) {
      toast.error("Reorder failed", { description: res.message });
      router.refresh();
      return;
    }
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
              {localeName(locale)} · {filtered.length} image
              {filtered.length === 1 ? "" : "s"}
            </p>
            <h2
              className="mt-1 font-display text-2xl tracking-[-0.01em]"
              style={{ fontVariationSettings: "'wght' 500" }}
            >
              Screenshots
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="md" onClick={() => setOpenBulk(true)}>
              <FolderArchive size={14} /> Bulk import ZIP
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => setOpenApply(true)}
              disabled={filtered.length === 0}
              title={filtered.length === 0 ? "Add at least one screenshot first" : ""}
            >
              <Copy size={14} /> Apply to other locales
            </Button>
            <Button variant="secondary" size="md" onClick={pullFromStore} disabled={fetching}>
              {fetching ? <Spinner size={12} /> : <DownloadCloud size={14} />} Pull from store
            </Button>
            <Button variant="primary" size="md" onClick={() => setOpenUpload(true)}>
              <Plus size={14} /> Upload
            </Button>
          </div>
        </div>

        <nav
          aria-label="Device / image type"
          className="mb-4 flex flex-wrap items-center gap-1 border-b-[0.5px] border-[var(--stroke-default)] pb-2"
        >
          {typeOptions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setDisplayType(t)}
              className={cn(
                "rounded-[var(--radius-xs)] px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.04em] transition-colors",
                t === displayType
                  ? "bg-[var(--signal-tint)] text-[var(--ink-primary)] ring-[1.5px] ring-[var(--signal)]"
                  : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
              )}
            >
              {t}
            </button>
          ))}
        </nav>

        {filtered.length === 0 ? (
          <EmptyState onUpload={() => setOpenUpload(true)} onBulk={() => setOpenBulk(true)} />
        ) : (
          <SortableGrid
            items={filtered}
            onCommit={(ids) => void commitReorder(ids)}
            renderCard={(s, dragHandle) => (
              <ScreenshotCard
                s={s}
                busy={busy.has(s.id)}
                dragHandle={dragHandle}
                onOpen={() => setLightboxId(s.id)}
                onDelete={() => void deleteOne(s.id)}
              />
            )}
          />
        )}

        <UploadDialog
          open={openUpload}
          onClose={() => setOpenUpload(false)}
          appId={props.appId}
          platform={props.platform}
          locale={locale}
          displayType={displayType}
          currentCount={filtered.length}
          onUploaded={onUploadComplete}
        />

        <BulkImportSheet
          open={openBulk}
          onClose={() => setOpenBulk(false)}
          appId={props.appId}
        />

        <ApplyToLocalesSheet
          open={openApply}
          onClose={() => setOpenApply(false)}
          appId={props.appId}
          sourceLocale={locale}
          displayType={displayType}
          availableLocales={localeOptions}
        />

        {lightboxItem && (
          <Lightbox
            src={
              lightboxItem.storageKey
                ? `/api/v1/storage/${lightboxItem.storageKey}`
                : lightboxItem.upstreamUrl ?? thumbUrl(lightboxItem)
            }
            fileName={lightboxItem.fileName}
            meta={`${lightboxItem.width}×${lightboxItem.height} · ${
              lightboxItem.fileSize
                ? `${(lightboxItem.fileSize / 1024).toFixed(1)} KB`
                : "—"
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
        title="Delete this screenshot?"
        description="The screenshot is removed locally and from the App Store / Google Play upstream."
        confirmLabel="Delete"
        pending={deletingId !== null}
      />
    </div>
  );
}

function ScreenshotCard({
  s,
  busy,
  dragHandle,
  onOpen,
  onDelete,
}: {
  s: ScreenshotRow;
  busy: boolean;
  dragHandle: React.ReactNode;
  onOpen: () => void;
  onDelete: () => void;
}): JSX.Element {
  const url = thumbUrl(s);
  const state = s.state === "COMPLETE" ? "synced" : s.state === "UPLOAD_FAILED" ? "error" : "syncing";
  return (
    <div className="group relative overflow-hidden rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)]">
      <button
        type="button"
        onClick={onOpen}
        className="block aspect-[9/16] w-full overflow-hidden bg-[var(--surface-sunken)]"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={s.fileName}
            className="h-full w-full object-cover transition-transform duration-[260ms] group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon size={24} className="text-[var(--ink-quaternary)]" />
          </div>
        )}
      </button>
      <div className="flex items-center justify-between border-t-[0.5px] border-[var(--stroke-default)] px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--ink-secondary)]">
          {dragHandle}
          <StateDot state={state} />
          {s.ordinal.toString().padStart(2, "0")} · {s.width}×{s.height}
        </span>
        <div className="flex items-center gap-1">
          {busy ? (
            <Spinner size={10} />
          ) : (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete screenshot"
              className="rounded-[var(--radius-xs)] p-1 text-[var(--ink-tertiary)] hover:bg-[var(--status-danger-tint)] hover:text-[var(--status-danger)]"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
      {s.state !== "COMPLETE" && (
        <Stamp
          variant={s.state === "UPLOAD_FAILED" ? "danger" : "info"}
          className="absolute left-2 top-2"
        >
          {s.state}
        </Stamp>
      )}
    </div>
  );
}

function EmptyState({
  onUpload,
  onBulk,
}: {
  onUpload: () => void;
  onBulk: () => void;
}): JSX.Element {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-sunken)] p-12 text-center">
      <ImageIcon size={32} className="mx-auto text-[var(--ink-quaternary)]" />
      <h3
        className="mt-4 font-display text-xl"
        style={{ fontVariationSettings: "'wght' 500" }}
      >
        No screenshots in this slot yet
      </h3>
      <p className="mx-auto mt-2 max-w-md font-body text-[13px] text-[var(--ink-secondary)]">
        Drop images for this device type and locale, or import a structured ZIP at once.
        We validate dimensions before sending them to the store.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="primary" size="md" onClick={onUpload}>
          <Plus size={14} /> Upload screenshots
        </Button>
        <Button variant="ghost" size="md" onClick={onBulk}>
          <FolderArchive size={14} /> Bulk import ZIP
        </Button>
      </div>
    </div>
  );
}
