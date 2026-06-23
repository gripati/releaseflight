"use client";

/**
 * Sub-navigation for the Keywords surface.
 *
 *   Opportunities · Tracked · Competitors · History       [page actions]
 *                                                          ↑ portal slot
 *
 * Layout: flex row with the tab strip on the left and a portal-target
 * `<div id="keywords-subnav-actions">` on the right. Each page surface
 * (KeywordsOpportunitiesSurface, CompetitorsPanel, etc.) mounts its
 * primary actions into that slot via `createPortal`, so "Sync all",
 * "Run Astro", and friends live in one consistent location — the tab
 * row's right edge — instead of duplicated panel headers.
 *
 * Preserves the `?locale` search param across tab switches so the
 * locale strip stays in sync — clicking "Tracked" while a locale is
 * picked keeps that scope instead of resetting it.
 *
 * Tab order is deliberate: Opportunities (discover) → Tracked (manage)
 * → Competitors (compare) → History (audit). History sits last because
 * it's the look-back surface; everything else is forward-looking.
 */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { cn } from "@marquee/ui";

export interface KeywordsSubNavProps {
  tenantSlug: string;
  appId: string;
}

interface Tab {
  slug: string;
  label: string;
}

const TABS: readonly Tab[] = [
  { slug: "", label: "Opportunities" },
  { slug: "tracked", label: "Tracked" },
  { slug: "competitors", label: "Competitors" },
  { slug: "history", label: "History" },
];

/** Stable DOM id pages portal their actions into. Exported so the
 *  client surfaces can pin to the exact same string instead of
 *  hand-typing a literal each time. */
export const KEYWORDS_SUBNAV_ACTIONS_ID = "keywords-subnav-actions";

export function KeywordsSubNav({
  tenantSlug,
  appId,
}: KeywordsSubNavProps): JSX.Element {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const base = `/t/${tenantSlug}/apps/${appId}/keywords`;
  // Carry the current locale (and any other params) across tab clicks
  // so the locale strip's scope persists. Without this every tab switch
  // would reset ?locale to "ALL".
  const qs = useMemo(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [searchParams]);
  const tabs = useMemo(
    () =>
      TABS.map((t) => ({
        ...t,
        href: `${t.slug ? `${base}/${t.slug}` : base}${qs}`,
        // For active-state matching we ignore the query string.
        activeBase: t.slug ? `${base}/${t.slug}` : base,
      })),
    [base, qs],
  );

  return (
    <div className="-mt-1 mb-6 flex items-stretch justify-between gap-3 border-b border-[var(--stroke-default)]">
      {/* Tabs — horizontal scroll on narrow viewports so the row never
       *  pushes the page past the viewport edge. */}
      <nav
        aria-label="Keywords sections"
        className="scroll-fine flex items-stretch gap-0 overflow-x-auto"
      >
        {tabs.map((t) => {
          const isActive = t.slug
            ? pathname === t.activeBase || pathname.startsWith(`${t.activeBase}/`)
            : pathname === t.activeBase;
          return (
            <Link
              key={t.label}
              href={t.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative shrink-0 px-4 py-2.5 text-[13px] font-medium outline-none transition-colors",
                "focus-visible:rounded-[var(--radius-xs)] focus-visible:ring-2 focus-visible:ring-[var(--signal)]",
                isActive
                  ? "text-[var(--ink-primary)]"
                  : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
              )}
            >
              {t.label}
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-opacity",
                  isActive
                    ? "bg-[var(--signal)] opacity-100"
                    : "bg-[var(--ink-primary)] opacity-0 group-hover:opacity-30",
                )}
              />
            </Link>
          );
        })}
      </nav>

      {/* Actions slot — pages portal their primary CTAs in here so the
       *  page-title strap can vanish entirely. `pb-2` aligns the action
       *  buttons' vertical centre with the tab labels' centre; `pl-2`
       *  prevents them from kissing the last tab when the nav doesn't
       *  scroll. The id is stable for `document.getElementById` lookups
       *  inside `createPortal`. */}
      <div
        id={KEYWORDS_SUBNAV_ACTIONS_ID}
        className="flex shrink-0 items-center gap-2 pb-2 pl-2"
      />
    </div>
  );
}
