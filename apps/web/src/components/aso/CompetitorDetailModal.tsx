"use client";

/**
 * CompetitorDetailModal — one competitor, every territory.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ 🪄 Magic Sort!                                              ✕ │
 *   │ Grand Games · ★4.53 · v25.79 · last synced 2 min ago           │
 *   │                                                                │
 *   │ [🇹🇷 TR] [🇺🇸 US] [🇩🇪 DE] [🇫🇷 FR] [🇯🇵 JP] [🇰🇷 KR] [🇪🇸 ES] …   │
 *   │                                                                │
 *   │  Subtitle   "Match colors. Sort water…"                       │
 *   │  Version    25.79 · released May 14, 2026                     │
 *   │  Rating     4.53 ★  (23,034 ratings)                          │
 *   │  Price      Free                                              │
 *   │  Genre      Games · Puzzle · Casual                           │
 *   │                                                                │
 *   │  Screenshots (8 iPhone · 8 iPad)                              │
 *   │  ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐                             │
 *   │  └──┘└──┘└──┘└──┘└──┘└──┘└──┘└──┘                             │
 *   │                                                                │
 *   │  Description                                                  │
 *   │  Discover Magic Sort! Mix colors in a world where every…      │
 *   │                                                                │
 *   │  Release notes                                                │
 *   │  v25.79 — bug fixes and stability improvements.               │
 *   │                                                                │
 *   │  Recent changes (30 days)                                     │
 *   │  • Yesterday · v25.79 released                                │
 *   │  • 3 days ago · 2 screenshots added                           │
 *   │  • 5 days ago · Description rewritten                         │
 *   └────────────────────────────────────────────────────────────────┘
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Star,
  ExternalLink,
  AlertOctagon,
  AlertTriangle,
  Info as InfoIcon,
  Clock,
} from "lucide-react";
import { territoryFlag } from "@marquee/core/locale";
import { Spinner, cn } from "@marquee/ui";

interface SnapshotPayload {
  territory: string;
  date: string;
  fetchedAt: string;
  name: string | null;
  subtitle: string | null;
  description: string | null;
  releaseNotes: string | null;
  version: string | null;
  currentVersionReleaseDate: string | null;
  averageUserRating: number | null;
  userRatingCount: number | null;
  iconUrl: string | null;
  iphoneScreenshotUrls: string[];
  ipadScreenshotUrls: string[];
  sellerName: string | null;
  primaryGenre: string | null;
  genres: string[];
  contentAdvisoryRating: string | null;
  minimumOsVersion: string | null;
  languageCodes: string[];
  price: number | null;
  currency: string | null;
  formattedPrice: string | null;
  trackUrl: string | null;
}

interface ChangeEntry {
  id: string;
  date: string;
  severity: "info" | "warning" | "danger";
  title: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface DetailResponse {
  competitor: {
    id: string;
    appName: string;
    iconUrl: string | null;
    trackUrl: string | null;
    sellerName: string | null;
    primaryGenre: string | null;
    latestVersion: string | null;
    latestRating: number | null;
    latestRatingCount: number | null;
    lastSyncedAt: string | null;
    bucket: string | null;
    monitor: boolean;
  };
  territories: SnapshotPayload[];
  changes: ChangeEntry[];
}

export function CompetitorDetailModal({
  appId,
  competitorId,
  homeTerritory,
  onClose,
}: {
  appId: string;
  competitorId: string;
  homeTerritory: string;
  onClose: () => void;
}): JSX.Element | null {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeTerritory, setActiveTerritory] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/v1/apps/${appId}/aso/competitors/${competitorId}/snapshots`, {
          credentials: "include",
          signal: ac.signal,
        });
        if (!res.ok) {
          setErr(`HTTP ${res.status.toString()}`);
          return;
        }
        const json = (await res.json()) as DetailResponse;
        setData(json);
        // Default to home territory if it exists in the snapshot set,
        // else first available.
        const home = json.territories.find((t) => t.territory === homeTerritory);
        setActiveTerritory(home?.territory ?? json.territories[0]?.territory ?? null);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => ac.abort();
  }, [appId, competitorId, homeTerritory]);

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

  const active = useMemo(
    () => data?.territories.find((t) => t.territory === activeTerritory) ?? null,
    [data, activeTerritory],
  );

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
          "fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(880px,94vw)]",
          "-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
          "rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] shadow-2xl",
        )}
      >
        {/* ── Header — three-row identity block ─────────────────────
         *  Row 1  app name                       [App Store ↗] [✕]
         *  Row 2  seller · ★rating · vN · synced
         *  Row 3  Free • Genres • iOS • Advisory • N languages
         *
         *  Icon scales to span all three rows (64 px) so the visual
         *  weight stays balanced with the taller text column. The
         *  meta strip (row 3) is per-active-territory; it re-renders
         *  when the operator picks a different territory tab. */}
        {data ? (
          <header className="flex items-start gap-4 border-b border-[var(--stroke-soft)] px-5 py-4">
            {data.competitor.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.competitor.iconUrl}
                alt=""
                className="h-[72px] w-[72px] shrink-0 rounded-[16px] bg-[var(--surface-tinted)] object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1 space-y-1.5">
              {/* Row 1 — app name */}
              <h2
                className="font-display truncate text-[19px] leading-tight tracking-[-0.005em] text-[var(--ink-primary)]"
                style={{ fontVariationSettings: "'wght' 600" }}
              >
                {data.competitor.appName}
              </h2>

              {/* Row 2 — seller + key stats */}
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--ink-tertiary)]">
                {data.competitor.sellerName && (
                  <span className="font-medium text-[var(--ink-secondary)]">
                    {data.competitor.sellerName}
                  </span>
                )}
                {data.competitor.latestRating != null && (
                  <>
                    <Dot />
                    <span className="inline-flex items-center gap-1">
                      <Star size={11} className="fill-[#FFB400] text-[#FFB400]" />
                      <span className="font-semibold text-[var(--ink-secondary)] tabular-nums">
                        {data.competitor.latestRating.toFixed(2)}
                      </span>
                    </span>
                  </>
                )}
                {data.competitor.latestVersion && (
                  <>
                    <Dot />
                    <span className="font-mono tabular-nums">v{data.competitor.latestVersion}</span>
                  </>
                )}
                {data.competitor.lastSyncedAt && (
                  <>
                    <Dot />
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} />
                      synced {formatRelative(data.competitor.lastSyncedAt)}
                    </span>
                  </>
                )}
              </p>

              {/* Row 3 — per-territory meta strip (only when a
                   snapshot is loaded for the active tab) */}
              {active && <HeaderMetaStrip snapshot={active} />}
            </div>

            <div className="flex shrink-0 items-center gap-1 pt-1">
              {data.competitor.trackUrl && (
                <a
                  href={data.competitor.trackUrl}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 rounded-[var(--radius)] px-2 py-1 text-[11px] font-semibold text-[var(--signal)] transition-colors hover:bg-[var(--signal-tint)]"
                >
                  App Store
                  <ExternalLink size={11} />
                </a>
              )}
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
        ) : (
          <header className="flex items-center gap-2 border-b border-[var(--stroke-soft)] px-5 py-3 text-[12px] text-[var(--ink-tertiary)]">
            <Spinner size={12} /> Loading competitor…
          </header>
        )}

        {/* Territory tabs */}
        {data && data.territories.length > 0 && (
          <nav className="scroll-fine flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--stroke-soft)] px-3 py-2">
            {data.territories.map((t) => (
              <button
                key={t.territory}
                type="button"
                onClick={() => setActiveTerritory(t.territory)}
                className={cn(
                  "shrink-0 rounded-[var(--radius)] px-2.5 py-1 text-[12px] font-medium transition-colors",
                  activeTerritory === t.territory
                    ? "bg-[var(--ink-primary)] text-[var(--surface-paper)]"
                    : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]",
                )}
              >
                <span className="mr-1">{territoryFlag(t.territory)}</span>
                {t.territory}
              </button>
            ))}
          </nav>
        )}

        {/* Body */}
        <div className="scroll-fine flex-1 overflow-y-auto px-5 py-4">
          {err ? (
            <p className="rounded-[var(--radius)] bg-[var(--status-danger-tint)] px-3 py-2 text-[12px] text-[var(--status-danger)]">
              {err}
            </p>
          ) : !data ? (
            <SkeletonBody />
          ) : !active ? (
            <p className="text-[12px] text-[var(--ink-tertiary)]">
              No snapshots yet — the nightly sync hasn't captured this competitor in any storefront.
              Click "Sync now" to trigger one.
            </p>
          ) : (
            <SnapshotBody snapshot={active} />
          )}

          {data && data.changes.length > 0 && (
            <section className="mt-6">
              <h3 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
                Change timeline · last 30 days
              </h3>
              <ol className="space-y-2">
                {data.changes.map((c) => (
                  <ChangeRow key={c.id} change={c} />
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function SnapshotBody({ snapshot }: { snapshot: SnapshotPayload }): JSX.Element {
  return (
    <div className="space-y-5">
      {/* Subtitle — territory-specific marketing copy. The summary
       *  meta strip (price / genres / OS / advisory / languages)
       *  lives on the modal header now; only the subtitle and the
       *  screenshot/description sections render in the body. */}
      {snapshot.subtitle && (
        <p className="text-[14px] leading-snug text-[var(--ink-secondary)] italic">
          &ldquo;{snapshot.subtitle}&rdquo;
        </p>
      )}

      {/* Screenshots */}
      {snapshot.iphoneScreenshotUrls.length > 0 && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            iPhone screenshots · {snapshot.iphoneScreenshotUrls.length.toString()}
          </h3>
          <div className="scroll-fine flex gap-2 overflow-x-auto pb-2">
            {snapshot.iphoneScreenshotUrls.map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noopener" className="shrink-0">
                <img
                  src={u}
                  alt={`Screenshot ${(i + 1).toString()}`}
                  className="h-44 rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] object-cover"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        </section>
      )}

      {snapshot.ipadScreenshotUrls.length > 0 && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            iPad screenshots · {snapshot.ipadScreenshotUrls.length.toString()}
          </h3>
          <div className="scroll-fine flex gap-2 overflow-x-auto pb-2">
            {snapshot.ipadScreenshotUrls.map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noopener" className="shrink-0">
                <img
                  src={u}
                  alt={`iPad screenshot ${(i + 1).toString()}`}
                  className="h-32 rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-tinted)] object-cover"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Description */}
      {snapshot.description && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Description
          </h3>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]">
            {snapshot.description}
          </p>
        </section>
      )}

      {/* Release notes */}
      {snapshot.releaseNotes && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-[var(--ink-tertiary)] uppercase">
            Release notes · v{snapshot.version ?? ""}
          </h3>
          <p className="rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-sunken)] px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]">
            {snapshot.releaseNotes}
          </p>
        </section>
      )}
    </div>
  );
}

/** A larger, more-visible separator dot than the text bullet — sits
 *  between header chips. Rendered as a small rounded span so its
 *  visual weight is uniform regardless of the surrounding font. */
function Dot(): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--ink-quaternary)]"
    />
  );
}

/** Per-territory meta strip rendered as row 3 of the modal header.
 *  Lazily builds the chip list — every field is optional and the
 *  Dot separators only render between two present chips. Languages
 *  always slot last so the truncated ISO-code list trails naturally
 *  on small viewports. */
function HeaderMetaStrip({ snapshot }: { snapshot: SnapshotPayload }): JSX.Element | null {
  const chips: { key: string; node: JSX.Element }[] = [];
  const priceLabel = snapshot.formattedPrice ?? (snapshot.price === 0 ? "Free" : null);
  if (priceLabel) {
    chips.push({
      key: "price",
      node: <span className="font-semibold text-[var(--ink-primary)]">{priceLabel}</span>,
    });
  }
  if (snapshot.genres.length > 0) {
    chips.push({
      key: "genres",
      node: <span className="text-[var(--ink-secondary)]">{snapshot.genres.join(" / ")}</span>,
    });
  }
  if (snapshot.minimumOsVersion) {
    chips.push({
      key: "os",
      node: (
        <span className="font-mono text-[var(--ink-secondary)] tabular-nums">
          iOS {snapshot.minimumOsVersion}+
        </span>
      ),
    });
  }
  if (snapshot.contentAdvisoryRating) {
    chips.push({
      key: "adv",
      node: (
        <span className="font-mono text-[var(--ink-secondary)]">
          {snapshot.contentAdvisoryRating}
        </span>
      ),
    });
  }
  if (snapshot.languageCodes.length > 0) {
    const codes = snapshot.languageCodes.join(", ");
    chips.push({
      key: "langs",
      // Languages chip carries its inline truncated code list — count
      // label stays full-width, the parenthesised codes truncate with
      // ellipsis when they don't fit. Tooltip shows the full list on
      // hover. min-w-0 + truncate are both required for the ellipsis
      // to actually clip in a flex parent.
      node: (
        <span
          className="inline-flex max-w-[260px] min-w-0 items-baseline gap-1.5 text-[var(--ink-secondary)]"
          title={codes}
        >
          <span className="shrink-0">{snapshot.languageCodes.length.toString()} languages</span>
          <span className="min-w-0 truncate font-mono text-[10.5px] tracking-[0.02em] text-[var(--ink-tertiary)]">
            ({codes})
          </span>
        </span>
      ),
    });
  }
  if (chips.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
      {chips.map((c, i) => (
        <span key={c.key} className="inline-flex min-w-0 items-center gap-2.5">
          {i > 0 && <Dot />}
          {c.node}
        </span>
      ))}
    </p>
  );
}

function ChangeRow({ change }: { change: ChangeEntry }): JSX.Element {
  const Icon =
    change.severity === "danger"
      ? AlertOctagon
      : change.severity === "warning"
        ? AlertTriangle
        : InfoIcon;
  const tone =
    change.severity === "danger"
      ? "var(--status-danger)"
      : change.severity === "warning"
        ? "#975A16"
        : "var(--status-info)";
  return (
    <li className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--stroke-soft)] bg-[var(--surface-paper)] px-3 py-2">
      <span
        aria-hidden
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full"
        style={{ background: `color-mix(in oklab, ${tone} 14%, transparent)`, color: tone }}
      >
        <Icon size={10} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-[var(--ink-primary)]">{change.title}</p>
        <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ink-secondary)]">
          {change.message}
        </p>
      </div>
      <span className="shrink-0 font-mono text-[10px] text-[var(--ink-tertiary)]">
        {change.date}
      </span>
    </li>
  );
}

function SkeletonBody(): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-[var(--radius)] bg-[var(--surface-tinted)]"
          />
        ))}
      </div>
      <div className="h-44 animate-pulse rounded-[var(--radius)] bg-[var(--surface-tinted)]" />
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min.toString()} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr.toString()}h ago`;
  const d = Math.round(hr / 24);
  if (d < 14) return `${d.toString()}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
