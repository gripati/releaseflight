"use client";

/**
 * CompetitorCompareModal — side-by-side comparison of 2-3 competitors.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Compare 3 competitors · 🇹🇷 TR ▾                            ✕ │
 *   │                                                                │
 *   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐           │
 *   │  │ 🪄 Magic Sort │ │ 🧩 Block Saga │ │ 🎯 Color Shoot │           │
 *   │  │  ★4.53 23K    │ │  ★4.61 41K    │ │  ★4.22 12K    │           │
 *   │  │  v25.79       │ │  v8.4.0       │ │  v1.2.3       │           │
 *   │  │  Free         │ │  Free         │ │  $2.99        │           │
 *   │  └──────────────┘ └──────────────┘ └──────────────┘           │
 *   │                                                                │
 *   │  Subtitle                                                     │
 *   │  • Match colors        • Build & stack      • Tap to shoot    │
 *   │                                                                │
 *   │  Screenshots                                                  │
 *   │  [thumb][thumb]…       [thumb][thumb]…      [thumb][thumb]…   │
 *   │                                                                │
 *   │  Description                                                  │
 *   │  …                     …                    …                 │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Fetches every selected competitor's snapshots in parallel, picks the
 * snapshot matching the active territory (defaults to the operator's
 * home territory), and lays them out in columns. Territory picker at
 * the top lets the operator swap to a different storefront to see how
 * competitors localize differently.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Star } from "lucide-react";
import { territoryFlag, territoryName } from "@marquee/core/locale";
import { Spinner, cn } from "@marquee/ui";

interface SnapshotPayload {
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
  primaryGenre: string | null;
  formattedPrice: string | null;
  price: number | null;
}

interface DetailResponse {
  competitor: {
    id: string;
    appName: string;
    iconUrl: string | null;
    sellerName: string | null;
  };
  territories: SnapshotPayload[];
}

export function CompetitorCompareModal({
  appId,
  competitorIds,
  homeTerritory,
  appTerritories,
  onClose,
}: {
  appId: string;
  competitorIds: string[];
  homeTerritory: string;
  /** Territories the operator's app actually ships in — used to
   *  narrow the territory picker. Without this filter the picker
   *  would list every storefront the competitors are available in,
   *  even ones the operator can't act on. */
  appTerritories: string[];
  onClose: () => void;
}): JSX.Element | null {
  const [bundles, setBundles] = useState<DetailResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [activeTerritory, setActiveTerritory] = useState<string>(homeTerritory);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        setLoading(true);
        const results = await Promise.all(
          competitorIds.map((id) =>
            fetch(`/api/v1/apps/${appId}/aso/competitors/${id}/snapshots`, {
              credentials: "include",
              signal: ac.signal,
            }).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status.toString()}`);
              return r.json() as Promise<DetailResponse>;
            }),
          ),
        );
        setBundles(results);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [appId, competitorIds]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Territory picker options: every territory at least one selected
  // competitor covers, INTERSECTED with the operator's app territories
  // so we don't surface storefronts the operator can't act on. The
  // intersection is what "show me only locales my app ships in" means
  // in practice — competitor data exists for FR but if our app isn't
  // localized there, showing it would be noise.
  const pickerTerritories = useMemo(() => {
    const covered = new Set<string>();
    for (const b of bundles) for (const t of b.territories) covered.add(t.territory);
    const appSet = new Set(appTerritories.map((t) => t.toUpperCase()));
    return Array.from(covered)
      .filter((t) => appSet.has(t.toUpperCase()))
      .sort();
  }, [bundles, appTerritories]);

  // If the home territory isn't in the picker options (e.g. the
  // operator's primary locale has no competitor snapshot yet), fall
  // back to the first available so the grid renders SOMETHING.
  useEffect(() => {
    if (pickerTerritories.length === 0) return;
    if (!pickerTerritories.includes(activeTerritory)) {
      setActiveTerritory(pickerTerritories[0]!);
    }
  }, [pickerTerritories, activeTerritory]);

  if (typeof window === "undefined") return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[92vh] w-[min(1180px,96vw)]",
          "-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
          "rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] shadow-2xl",
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--stroke-soft)] px-5 py-3">
          <h2
            className="font-display text-[17px] tracking-[-0.005em] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            Comparing {competitorIds.length.toString()} competitor
            {competitorIds.length === 1 ? "" : "s"}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1 text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {/* ── Territory strip ───────────────────────────────────────
         *  Same horizontal flag-chip pattern as the system-wide
         *  LocaleStrip (Metadata / Keywords / Screenshots / Previews).
         *  Renders only territories where the operator's app ships
         *  AND at least one selected competitor has a snapshot. */}
        {pickerTerritories.length > 0 && (
          <nav
            aria-label="Territory picker"
            className="scroll-fine flex items-center gap-1.5 overflow-x-auto border-b border-[var(--stroke-soft)] bg-[var(--surface-paper)] px-3 py-2"
          >
            {pickerTerritories.map((t) => {
              const isActive = t === activeTerritory;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActiveTerritory(t)}
                  aria-pressed={isActive}
                  title={territoryName(t)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[12px] leading-none font-medium transition-colors",
                    isActive
                      ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                      : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
                  )}
                >
                  <span aria-hidden className="text-[14px] leading-none">
                    {territoryFlag(t)}
                  </span>
                  <span className="font-mono tabular-nums">{t}</span>
                </button>
              );
            })}
          </nav>
        )}

        <div className="scroll-fine flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-[var(--ink-tertiary)]">
              <Spinner size={12} /> Loading snapshots…
            </div>
          )}
          {err && !loading && (
            <p className="m-5 rounded-[var(--radius)] bg-[var(--status-danger-tint)] px-3 py-2 text-[12px] text-[var(--status-danger)]">
              {err}
            </p>
          )}
          {!loading && !err && <CompareGrid bundles={bundles} territory={activeTerritory} />}
        </div>
      </div>
    </>,
    document.body,
  );
}

function CompareGrid({
  bundles,
  territory,
}: {
  bundles: DetailResponse[];
  territory: string;
}): JSX.Element {
  const snaps = bundles.map((b) => ({
    competitor: b.competitor,
    snapshot: b.territories.find((t) => t.territory === territory) ?? null,
  }));
  return (
    <div
      className="grid auto-rows-min gap-px bg-[var(--stroke-soft)]"
      style={{ gridTemplateColumns: `repeat(${snaps.length.toString()}, minmax(0, 1fr))` }}
    >
      {/* Header row — competitor identity + key stats */}
      {snaps.map(({ competitor, snapshot }) => (
        <div key={`hdr-${competitor.id}`} className="bg-[var(--surface-elevated)] px-4 py-3">
          <div className="flex items-center gap-2">
            {competitor.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={competitor.iconUrl}
                alt=""
                className="h-9 w-9 rounded-[10px] bg-[var(--surface-tinted)] object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <p
                className="font-display truncate text-[14px] leading-tight text-[var(--ink-primary)]"
                title={competitor.appName}
              >
                {competitor.appName}
              </p>
              <p className="truncate text-[10px] text-[var(--ink-tertiary)]">
                {competitor.sellerName ?? "—"}
              </p>
            </div>
          </div>
          {snapshot ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              {snapshot.averageUserRating != null && (
                <span className="inline-flex items-center gap-0.5 text-[var(--ink-secondary)]">
                  <Star size={10} className="fill-[#FFB400] text-[#FFB400]" />
                  <span className="font-semibold tabular-nums">
                    {snapshot.averageUserRating.toFixed(2)}
                  </span>
                  <span className="text-[var(--ink-tertiary)]">
                    · {formatCompact(snapshot.userRatingCount ?? 0)}
                  </span>
                </span>
              )}
              {snapshot.version && (
                <span className="font-mono text-[var(--ink-tertiary)]">v{snapshot.version}</span>
              )}
              <span className="text-[var(--ink-tertiary)]">
                {snapshot.formattedPrice ?? (snapshot.price === 0 ? "Free" : "—")}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--ink-tertiary)]">Not in {territory}.</p>
          )}
        </div>
      ))}

      <CompareSection label="Subtitle" rows={snaps.map((s) => s.snapshot?.subtitle ?? null)} />
      <CompareScreenshotsRow snaps={snaps} />
      <CompareSection label="Genre" rows={snaps.map((s) => s.snapshot?.primaryGenre ?? null)} />
      <CompareSection
        label="Description"
        rows={snaps.map((s) => s.snapshot?.description ?? null)}
        clamped
      />
    </div>
  );
}

function CompareSection({
  label,
  rows,
  clamped,
}: {
  label: string;
  rows: (string | null)[];
  clamped?: boolean;
}): JSX.Element {
  // Section label sits as a full-width strip above the value cells —
  // since we're inside an explicit-column grid, we render it via a
  // sub-grid row with `col-span` on a label cell + values below.
  return (
    <>
      <div className="col-span-full border-t border-[var(--stroke-soft)] bg-[var(--surface-sunken)] px-4 py-1.5 font-mono text-[9px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        {label}
      </div>
      {rows.map((value, i) => (
        <div
          key={`${label}-${i.toString()}`}
          className="bg-[var(--surface-elevated)] px-4 py-2 text-[12px] text-[var(--ink-primary)]"
        >
          {value == null || value.trim().length === 0 ? (
            <span className="text-[var(--ink-tertiary)]">—</span>
          ) : (
            <p
              className={cn(
                "leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]",
                clamped && "line-clamp-6",
              )}
            >
              {value}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

function CompareScreenshotsRow({
  snaps,
}: {
  snaps: { competitor: { id: string }; snapshot: SnapshotPayload | null }[];
}): JSX.Element {
  return (
    <>
      <div className="col-span-full border-t border-[var(--stroke-soft)] bg-[var(--surface-sunken)] px-4 py-1.5 font-mono text-[9px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
        Screenshots
      </div>
      {snaps.map(({ competitor, snapshot }) => (
        <div key={`shots-${competitor.id}`} className="bg-[var(--surface-elevated)] p-3">
          {snapshot && snapshot.iphoneScreenshotUrls.length > 0 ? (
            <div className="scroll-fine flex gap-1.5 overflow-x-auto pb-1">
              {snapshot.iphoneScreenshotUrls.slice(0, 8).map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noopener" className="shrink-0">
                  <img
                    src={u}
                    alt={`Screenshot ${(i + 1).toString()}`}
                    className="h-32 rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] object-cover"
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--ink-tertiary)]">—</p>
          )}
        </div>
      ))}
    </>
  );
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
