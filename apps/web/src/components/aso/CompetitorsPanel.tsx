"use client";

/**
 * CompetitorsPanel — modern competitor-intel surface.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Competitors                                  [Sync all  ↻]  │
 *   │  Track rival apps across every storefront your app serves.   │
 *   │                                                              │
 *   │  ┌────────────────────────────────────────────────────────┐  │
 *   │  │ 🔗 https://apps.apple.com/tr/app/...id6499209744  [Add] │  │
 *   │  └────────────────────────────────────────────────────────┘  │
 *   │                                                              │
 *   │  [Compare 2] when 2+ cards selected                          │
 *   │                                                              │
 *   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
 *   │  │ ⬜ 🪄 Magic   │ │ ⬜ 🧩 Block   │ │ ⬜ 🎯 Color   │          │
 *   │  │   Sort!       │ │   Saga 2      │ │   Shoot       │          │
 *   │  │ ★4.5 · 23K    │ │ ★4.6 · 41K    │ │ ★4.2 · 12K    │          │
 *   │  │ v25.79        │ │ v8.4.0        │ │ v1.2.3        │          │
 *   │  │ • 3 changes   │ │ • 1 change    │ │ no changes    │          │
 *   │  │ this week     │ │ this week     │ │ this week     │          │
 *   │  └──────────────┘ └──────────────┘ └──────────────┘          │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Click a card → opens detail modal with territory tabs + screenshot
 * strip + change timeline. Multi-select via checkboxes → "Compare N"
 * button opens a side-by-side comparison modal.
 *
 * Each card carries its own kebab menu: Sync now, Pause/Resume, Delete.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { KEYWORDS_SUBNAV_ACTIONS_ID } from "@/components/shell/KeywordsSubNav";
import {
  Plus,
  RefreshCw,
  Star,
  ExternalLink,
  MoreVertical,
  GitCompareArrows,
  AlertOctagon,
  AlertTriangle,
  Info as InfoIcon,
  X,
  Check,
  Pause,
  Play,
  Trash2,
  Clock,
} from "lucide-react";
import { Button, Spinner, cn } from "@marquee/ui";
import { toast } from "@/components/feedback/Toaster";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import { CompetitorDetailModal } from "./CompetitorDetailModal";
import { CompetitorCompareModal } from "./CompetitorCompareModal";

// ──────────────────────────────────────────────────────────────────────
// Types — must mirror the server page's loadCompetitorCards shape.
// ──────────────────────────────────────────────────────────────────────

export interface CompetitorCard {
  id: string;
  appName: string;
  bundleId: string | null;
  storeAppId: string | null;
  bucket: string | null;
  monitor: boolean;
  notes: string | null;
  iconUrl: string | null;
  trackUrl: string | null;
  sellerName: string | null;
  primaryGenre: string | null;
  ingestCountry: string | null;
  latestVersion: string | null;
  latestRating: number | null;
  latestRatingCount: number | null;
  lastSyncedAt: string | null;
  /** Snapshot for the currently-selected territory (driven by the
   *  Keywords LocaleStrip's `?locale=` URL param). Falls back to the
   *  operator's home territory when no scope is set. */
  snapshot: {
    territory: string;
    date: string;
    name: string | null;
    subtitle: string | null;
    description: string | null;
    version: string | null;
    averageUserRating: number | null;
    userRatingCount: number | null;
    iconUrl: string | null;
    iphoneScreenshotUrls: string[];
    ipadScreenshotUrls: string[];
    primaryGenre: string | null;
    /** Full Apple genre path, e.g. ["Games", "Puzzle", "Casual"]. */
    genres: string[];
    price: number | null;
    formattedPrice: string | null;
  } | null;
  recentChanges: {
    id: string;
    date: string;
    severity: "info" | "warning" | "danger";
    title: string;
    message: string;
  }[];
}

interface Props {
  appId: string;
  initialRows: CompetitorCard[];
  homeTerritory: string;
  /** Every territory the operator's app actually ships in — derived
   *  from active AppLocalization rows by the parent server page.
   *  Flows through to the compare modal's territory picker so it
   *  never lists storefronts the operator can't act on. */
  appTerritories: string[];
  /** Territory the cards are currently scoped to — the URL-driven
   *  selection resolved server-side. Equal to `homeTerritory` when
   *  "All locales" is active. Surfaces in the header strap so the
   *  operator always knows which storefront they're looking at. */
  selectedTerritory: string;
}

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export function CompetitorsPanel({
  appId,
  initialRows,
  homeTerritory,
  appTerritories,
  selectedTerritory,
}: Props): JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<CompetitorCard[]>(initialRows);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  // Sync local state with prop changes — router.refresh() after a
  // mutation triggers a fresh server fetch, which arrives as a new
  // `initialRows` value. Without this the panel never sees the new
  // data after an ingest / delete.
  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/v1/apps/${appId}/aso/competitors`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { competitors: CompetitorCard[] };
    setRows(data.competitors);
  }, [appId]);

  const csrf = useCallback(async () => {
    const r = await fetch("/api/v1/auth/csrf-token", { credentials: "include" });
    const j = (await r.json()) as { csrfToken: string };
    return j.csrfToken;
  }, []);

  const ingest = useCallback(
    async (url: string): Promise<boolean> => {
      const token = await csrf();
      const res = await fetch(`/api/v1/apps/${appId}/aso/competitors/ingest`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        toast.error("Couldn't add competitor", {
          description: err?.error?.message ?? `HTTP ${res.status.toString()}`,
        });
        return false;
      }
      const data = (await res.json()) as {
        competitor: { appName: string };
        capturedTerritories: string[];
        missingTerritories: string[];
        alreadyTracked: boolean;
      };
      if (data.alreadyTracked) {
        toast.warning(`${data.competitor.appName} is already tracked`);
      } else {
        toast.success(`Added ${data.competitor.appName}`, {
          description: `Captured ${data.capturedTerritories.length.toString()} territor${data.capturedTerritories.length === 1 ? "y" : "ies"}${
            data.missingTerritories.length > 0
              ? ` · ${data.missingTerritories.length.toString()} unavailable`
              : ""
          }`,
        });
      }
      await refresh();
      router.refresh();
      return true;
    },
    [appId, csrf, refresh, router],
  );

  const syncOne = useCallback(
    async (competitorId: string) => {
      const token = await csrf();
      const t = toast.loading("Syncing competitor…");
      const res = await fetch(`/api/v1/apps/${appId}/aso/competitors/sync`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({ competitorId }),
      });
      if (!res.ok) {
        toast.error("Sync failed", { id: t });
        return;
      }
      toast.success("Sync queued", {
        id: t,
        description: "Fresh snapshot lands in ~10 seconds.",
      });
      // Wait briefly then refresh — the job runs in the worker
      // (concurrency 1) so 10s is a comfortable upper bound.
      setTimeout(() => {
        void refresh();
        router.refresh();
      }, 10_000);
    },
    [appId, csrf, refresh, router],
  );

  const syncAll = useCallback(async () => {
    setSyncingAll(true);
    const token = await csrf();
    const res = await fetch(`/api/v1/apps/${appId}/aso/competitors/sync`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: JSON.stringify({}),
    });
    setSyncingAll(false);
    if (!res.ok) {
      toast.error("Sync failed");
      return;
    }
    toast.success("Sync queued for all competitors", {
      description: "Refresh in 30-60 seconds depending on roster size.",
    });
    setTimeout(() => {
      void refresh();
      router.refresh();
    }, 30_000);
  }, [appId, csrf, refresh, router]);

  const deleteOne = useCallback(
    async (competitorId: string, name: string) => {
      if (
        !confirm(
          `Stop tracking ${name}? Snapshot history will be deleted permanently.`,
        )
      ) {
        return;
      }
      const token = await csrf();
      const res = await fetch(
        `/api/v1/apps/${appId}/aso/competitors/${competitorId}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: { "x-csrf-token": token },
        },
      );
      if (!res.ok) {
        toast.error("Delete failed");
        return;
      }
      toast.success(`Removed ${name}`);
      setRows((prev) => prev.filter((r) => r.id !== competitorId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(competitorId);
        return next;
      });
      router.refresh();
    },
    [appId, csrf, router],
  );

  const toggleMonitor = useCallback(
    async (competitorId: string, next: boolean) => {
      const token = await csrf();
      const res = await fetch(
        `/api/v1/apps/${appId}/aso/competitors/${competitorId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": token,
          },
          body: JSON.stringify({ monitor: next }),
        },
      );
      if (!res.ok) {
        toast.error("Couldn't update monitor flag");
        return;
      }
      setRows((prev) =>
        prev.map((r) => (r.id === competitorId ? { ...r, monitor: next } : r)),
      );
    },
    [appId, csrf],
  );

  const toggleSelected = useCallback((competitorId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(competitorId)) next.delete(competitorId);
      else next.add(competitorId);
      return next;
    });
  }, []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );

  return (
    <div className="space-y-4">
      {/* ── Primary actions portal into the sub-nav's right slot ── */}
      <SubnavActions>
        {selectedIds.size >= 2 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setComparing(true)}
          >
            <GitCompareArrows size={12} />
            Compare {selectedIds.size}
          </Button>
        )}
        {selectedIds.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void syncAll()}
          disabled={syncingAll || rows.length === 0}
          title="Re-fetch every competitor from Apple"
        >
          {syncingAll ? <Spinner size={12} /> : <RefreshCw size={12} />}
          Sync all
        </Button>
      </SubnavActions>

      {/* ── URL paste bar ────────────────────────────────────────── */}
      <UrlIngestBar onIngest={ingest} />

      {/* ── Cards — vertical list of full-width horizontal rows ── */}
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <CompetitorCardItem
              key={r.id}
              row={r}
              territory={selectedTerritory}
              selected={selectedIds.has(r.id)}
              // When the operator has already picked at least one
              // competitor, every other card surfaces its checkbox so
              // they can stack the multi-select without hover-hunting.
              // Otherwise the checkbox stays hidden until row-hover,
              // keeping the default card visually quiet.
              anySelected={selectedIds.size > 0}
              onToggleSelect={() => toggleSelected(r.id)}
              onOpen={() => setDetailId(r.id)}
              onSync={() => void syncOne(r.id)}
              onDelete={() => void deleteOne(r.id, r.appName)}
              onToggleMonitor={() => void toggleMonitor(r.id, !r.monitor)}
            />
          ))}
        </ul>
      )}

      {/* ── Detail modal (single competitor, all territories) ─── */}
      {detailId && (
        <CompetitorDetailModal
          appId={appId}
          competitorId={detailId}
          homeTerritory={homeTerritory}
          onClose={() => setDetailId(null)}
        />
      )}

      {/* ── Compare modal (2+ competitors, primary territory) ─── */}
      {comparing && selectedRows.length >= 2 && (
        <CompetitorCompareModal
          appId={appId}
          competitorIds={selectedRows.map((r) => r.id)}
          homeTerritory={homeTerritory}
          appTerritories={appTerritories}
          onClose={() => setComparing(false)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// URL paste bar
// ──────────────────────────────────────────────────────────────────────

const URL_PATTERN =
  /^https?:\/\/(?:apps|itunes)\.apple\.com(?:\/[a-z]{2})?\/app(?:\/[^/]+)?\/id\d+/i;

function UrlIngestBar({
  onIngest,
}: {
  onIngest: (url: string) => Promise<boolean>;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const isValid = URL_PATTERN.test(url.trim());

  async function submit(): Promise<void> {
    if (!isValid || busy) return;
    setBusy(true);
    const ok = await onIngest(url.trim());
    setBusy(false);
    if (ok) setUrl("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-1.5"
    >
      <span aria-hidden className="pl-2.5 text-[var(--ink-tertiary)]">
        <Plus size={14} />
      </span>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste an App Store URL  ·  e.g. https://apps.apple.com/us/app/foo/id1234567890"
        className="flex-1 bg-transparent px-1 py-1.5 text-[13px] outline-none placeholder:text-[var(--ink-tertiary)]"
      />
      {url.length > 0 && (
        <span
          className={cn(
            "mr-1 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-mono text-[10px] font-semibold",
            isValid
              ? "bg-[var(--status-success-tint)] text-[var(--status-success)]"
              : "bg-[var(--status-danger-tint)] text-[var(--status-danger)]",
          )}
        >
          {isValid ? <Check size={10} /> : <X size={10} />}
          {isValid ? "valid" : "not an App Store URL"}
        </span>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={!isValid || busy}
      >
        {busy ? <Spinner size={12} /> : <Plus size={12} />}
        {busy ? "Adding…" : "Add"}
      </Button>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Card
// ──────────────────────────────────────────────────────────────────────

/**
 * Full-width competitor row — clean two-zone layout.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ ☐  [🪄]   Magic Sort!                       ★ 4.73 · 443.4K   ⋯  │  ← Header zone
 *   │           Grand Games · Games · Puzzle · Casual          v25.79   │
 *   │ ────────────────────────────────────────────────────────────────── │
 *   │  ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐ →                              │  ← Content zone
 *   │  └──┘└──┘└──┘└──┘└──┘└──┘└──┘└──┘                                │
 *   │  ⚠ 3 changes this week · synced 3 min ago                         │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Design notes:
 *   • Header zone is one horizontal row — checkbox · icon · 2-line
 *     identity · stats stack · kebab. Everything aligns to the icon's
 *     56 px vertical center so the eye stops bouncing.
 *   • Content zone is full-width below — screenshots use the entire
 *     card width (no icon-column indent). Footer status pill anchors
 *     to the same baseline so the card has a clear top→bottom rhythm.
 *   • Subtle divider between zones keeps the two halves visually
 *     parsable without heavy borders.
 *   • Live-updates: every per-snapshot field re-renders when the
 *     LocaleStrip above changes `?locale=` and the page server-fetches
 *     the right territory's snapshot.
 */
function CompetitorCardItem({
  row,
  territory,
  selected,
  anySelected,
  onToggleSelect,
  onOpen,
  onSync,
  onDelete,
  onToggleMonitor,
}: {
  row: CompetitorCard;
  territory: string;
  selected: boolean;
  /** Whether at least one competitor is currently selected. Drives
   *  the hover-reveal pattern: when something is already picked, every
   *  row's checkbox stays visible so the operator can stack the
   *  multi-select without hover-hunting. */
  anySelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onSync: () => void;
  onDelete: () => void;
  onToggleMonitor: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  // Per-territory snapshot drives everything; denormalised mirrors on
  // the Competitor row are the fallback when the picked territory has
  // no snapshot yet (e.g. app isn't shipped there).
  const rating = row.snapshot?.averageUserRating ?? row.latestRating;
  const ratingCount = row.snapshot?.userRatingCount ?? row.latestRatingCount;
  const version = row.snapshot?.version ?? row.latestVersion;
  const screenshots = row.snapshot?.iphoneScreenshotUrls ?? [];
  const cardIcon = row.snapshot?.iconUrl ?? row.iconUrl;
  const displayName = row.snapshot?.name ?? row.appName;
  const seller = row.sellerName ?? row.bundleId ?? null;
  // Apple ships a genre path (Games → Puzzle → Casual). The full
  // path is more informative than just the primary genre, and at
  // ~3-4 entries it never overflows the row.
  const genres =
    row.snapshot?.genres && row.snapshot.genres.length > 0
      ? row.snapshot.genres
      : row.primaryGenre
        ? [row.primaryGenre]
        : [];
  const noSnapshotForTerritory = row.snapshot === null;
  const worst: "info" | "warning" | "danger" | null = row.recentChanges.some(
    (c) => c.severity === "danger",
  )
    ? "danger"
    : row.recentChanges.some((c) => c.severity === "warning")
      ? "warning"
      : row.recentChanges.length > 0
        ? "info"
        : null;

  // Checkbox visibility — Gmail-style hover reveal. Always visible when
  // selected (so the operator knows what they've picked) or when *any*
  // card is selected (so they can stack). Otherwise only on row hover.
  const checkboxVisible = selected || anySelected;

  return (
    <li
      className={cn(
        "group relative rounded-[var(--radius-lg)] border bg-[var(--surface-elevated)] transition-[box-shadow] duration-150",
        selected
          ? "border-[var(--signal)] shadow-[0_0_0_1px_var(--signal)]"
          : "border-[var(--stroke-default)] hover:shadow-[0_6px_18px_-12px_rgba(0,0,0,0.18)]",
        !row.monitor && "opacity-70",
      )}
    >
      {/* Selection checkbox sits inside a reserved 40 px left gutter —
       *  the card's `pl-10` keeps that space whether the box is visible
       *  or not, so the icon + screenshots + footer text always align
       *  to the same inner left edge and the checkbox never overlaps
       *  the icon. Fades in on hover / focus / when anything is picked. */}
      <button
        type="button"
        aria-label={selected ? "Deselect" : "Select for comparison"}
        title={selected ? "Remove from compare set" : "Add to compare set"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        className={cn(
          // Vertical centre with the 56 px icon: header zone's `py-3`
          // = 12 px top padding, icon centre at 12 + 28 = 40 px from
          // the card top, checkbox is 16 px tall → top = 40 − 8 = 32.
          "absolute left-3 top-[32px] z-10 grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] border transition-[opacity,colors] duration-150 focus:outline-none focus-visible:opacity-100",
          selected
            ? "border-[var(--signal)] bg-[var(--signal)] text-[var(--signal-on)]"
            : "border-[var(--stroke-default)] bg-[var(--surface-paper)] hover:border-[var(--ink-tertiary)]",
          checkboxVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100",
        )}
      >
        {selected && <Check size={10} strokeWidth={3} />}
      </button>

      {/* ── Header zone — pl-10 = the reserved checkbox gutter ────── */}
      <div className="flex items-center gap-3 py-3 pl-10 pr-4">
        {/* Icon — 56 px, slightly smaller than the modal header's 72 px
         *  so the list row reads as compact + balanced against two
         *  lines of identity text. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${displayName}`}
          className="shrink-0 rounded-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)]"
        >
          {cardIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cardIcon}
              alt=""
              className="h-14 w-14 rounded-[12px] bg-[var(--surface-tinted)] object-cover"
            />
          ) : (
            <div className="grid h-14 w-14 place-items-center rounded-[12px] bg-[var(--surface-tinted)] font-display text-[22px] text-[var(--ink-tertiary)]">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </button>

        {/* Identity column — two clean lines */}
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left focus:outline-none"
        >
          <h3
            className="truncate font-display text-[15px] leading-snug text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 600" }}
            title={displayName}
          >
            {displayName}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[12px] text-[var(--ink-tertiary)]">
            {seller && (
              <span className="truncate text-[var(--ink-secondary)]">
                {seller}
              </span>
            )}
            {seller && genres.length > 0 && (
              <span aria-hidden className="text-[var(--ink-quaternary)]">
                ·
              </span>
            )}
            {genres.length > 0 && (
              <span className="truncate">{genres.join(" · ")}</span>
            )}
          </p>
        </button>

        {/* Stats stack — right-aligned, vertically centered with icon */}
        <div className="flex shrink-0 items-center gap-3">
          {rating != null && (
            <span
              className="inline-flex items-center gap-1 text-[12.5px] text-[var(--ink-secondary)]"
              title={
                ratingCount != null
                  ? `${rating.toFixed(2)} ★ across ${ratingCount.toLocaleString()} ratings`
                  : undefined
              }
            >
              <Star size={12} className="fill-[#FFB400] text-[#FFB400]" />
              <span className="font-semibold tabular-nums text-[var(--ink-primary)]">
                {rating.toFixed(2)}
              </span>
              {ratingCount != null && (
                <span className="text-[var(--ink-tertiary)]">
                  · {formatCompact(ratingCount)}
                </span>
              )}
            </span>
          )}
          {version && (
            <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--surface-tinted)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--ink-secondary)]">
              v{version}
            </span>
          )}

          {/* Kebab menu */}
          <div className="relative">
            <button
              type="button"
              aria-label="More actions"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="rounded-full p-1 text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
            >
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] shadow-[0_12px_28px_-12px_rgba(0,0,0,0.22)]">
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      onSync();
                    }}
                  >
                    <RefreshCw size={13} /> Sync now
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleMonitor();
                    }}
                  >
                    {row.monitor ? (
                      <>
                        <Pause size={13} /> Pause monitor
                      </>
                    ) : (
                      <>
                        <Play size={13} /> Resume monitor
                      </>
                    )}
                  </MenuItem>
                  {row.trackUrl && (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        window.open(row.trackUrl!, "_blank", "noopener");
                      }}
                    >
                      <ExternalLink size={13} /> Open in App Store
                    </MenuItem>
                  )}
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    danger
                  >
                    <Trash2 size={13} /> Delete
                  </MenuItem>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Hairline divider between zones */}
      <div className="border-t border-[var(--stroke-soft)]" aria-hidden />

      {/* ── Content zone — pl-10 mirrors the header's gutter so the
       *  screenshot strip + footer status align under the icon, with
       *  the empty checkbox column on the left of both zones. */}
      <div className="py-3 pl-10 pr-4">
        {screenshots.length > 0 ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="scroll-fine -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
          >
            {screenshots.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${src}-${i.toString()}`}
                src={src}
                alt=""
                className="h-36 w-auto shrink-0 rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] object-cover"
                loading="lazy"
              />
            ))}
          </div>
        ) : noSnapshotForTerritory ? (
          <p className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] px-2.5 py-1.5 text-[11.5px] text-[var(--ink-tertiary)]">
            Not available in {territory} — Apple has no listing for this
            competitor here.
          </p>
        ) : (
          <p className="text-[11.5px] text-[var(--ink-tertiary)]">
            No screenshots in the latest snapshot.
          </p>
        )}

        {/* Footer status strip — changes + last sync time */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11.5px]">
          {worst ? (
            <ChangePill worst={worst} count={row.recentChanges.length} />
          ) : (
            <span className="text-[var(--ink-tertiary)]">
              No changes this week
            </span>
          )}
          {row.lastSyncedAt && (
            <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[var(--ink-tertiary)]">
              <Clock size={11} />
              synced {formatRelativeShort(row.lastSyncedAt)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]",
        danger
          ? "text-[var(--status-danger)] hover:bg-[var(--status-danger-tint)]"
          : "text-[var(--ink-primary)] hover:bg-[var(--surface-tinted)]",
      )}
    >
      {children}
    </button>
  );
}

function ChangePill({
  worst,
  count,
}: {
  worst: "info" | "warning" | "danger";
  count: number;
}): JSX.Element {
  const tone =
    worst === "danger"
      ? {
          bg: "var(--status-danger-tint)",
          fg: "var(--status-danger)",
          Icon: AlertOctagon,
        }
      : worst === "warning"
        ? {
            bg: "rgba(214, 158, 46, 0.12)",
            fg: "#975A16",
            Icon: AlertTriangle,
          }
        : {
            bg: "var(--status-info-tint)",
            fg: "var(--status-info)",
            Icon: InfoIcon,
          };
  return (
    <span
      className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: tone.bg, color: tone.fg }}
    >
      <tone.Icon size={11} />
      {count.toString()} change{count === 1 ? "" : "s"} this week
    </span>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-8 text-center">
      <p className="font-display text-[16px] text-[var(--ink-primary)]">
        No competitors tracked yet
      </p>
      <p className="mt-1 text-[12px] text-[var(--ink-secondary)]">
        Paste an App Store URL above to start tracking — we'll pull metadata,
        ratings, and screenshots from every storefront your app serves, and
        run a daily diff sync.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Tight relative-time formatter for card footer ("3m", "2h", "5d"). */
function formatRelativeShort(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min.toString()}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr.toString()}h ago`;
  const d = Math.round(hr / 24);
  if (d < 14) return `${d.toString()}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Re-export the territory helpers consumers (modals) need from this
// surface, so they don't need to import @marquee/core directly.
export { territoryFlag, territoryName };

/**
 * SubnavActions — render children into the keywords sub-nav's right-
 * edge actions slot via React portal. The slot DOM node is owned by
 * `KeywordsSubNav` (id = KEYWORDS_SUBNAV_ACTIONS_ID). Two ergonomic
 * properties:
 *
 *   • Returns null on the server + the first client render, then
 *     mounts the portal once we've confirmed the target exists via
 *     `useEffect`. This avoids a flash of "actions rendered below the
 *     surface" before hydration finishes wiring up the portal.
 *   • If the slot DOM node disappears (e.g. operator navigates away),
 *     the portal silently no-ops on the next render.
 */
function SubnavActions({ children }: { children: React.ReactNode }): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById(KEYWORDS_SUBNAV_ACTIONS_ID));
  }, []);
  if (!host) return null;
  return createPortal(children, host);
}
