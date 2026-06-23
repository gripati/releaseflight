"use client";

/**
 * Per-app primary navigation (modern refresh).
 *
 *   Pulse · Studio · Keywords · Analytics · Library
 *
 * The previous version used a thin coloured underline on the active tab.
 * The refresh replaces that with a filled "pill" treatment — selected
 * tab gets a soft tinted background and bolder ink, hover gets a quieter
 * tinted background. Reads as a single segmented control rather than a
 * row of links with a hard-to-see underline, which is what you'd find
 * in Linear / Vercel / Notion.
 *
 * Active state is driven by `usePathname()` so the highlight lights up
 * reliably as the user navigates.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { cn } from "@marquee/ui";

export interface AppShellNavProps {
  tenantSlug: string;
  appId: string;
  counts?: {
    studioDirty?: number;
    keywordOpps?: number;
    pulseAlarms?: number;
  };
}

interface Tab {
  slug: string;
  label: string;
  activePrefixes: string[];
  badge?: number | undefined;
}

export function AppShellNav({
  tenantSlug,
  appId,
  counts,
}: AppShellNavProps): JSX.Element {
  const pathname = usePathname() ?? "";
  const base = `/t/${tenantSlug}/apps/${appId}`;

  const tabs = useMemo<Tab[]>(
    () => [
      {
        slug: "pulse",
        label: "Pulse",
        activePrefixes: [`${base}/pulse`],
        badge: counts?.pulseAlarms,
      },
      {
        slug: "metadata",
        label: "Metadata",
        // Active for both /metadata (canonical) and /studio (legacy
        // redirect) so the tab lights up during the brief redirect tick.
        activePrefixes: [`${base}/metadata`, `${base}/studio`],
        badge: counts?.studioDirty,
      },
      {
        slug: "keywords",
        label: "Keywords",
        activePrefixes: [`${base}/keywords`],
        badge: counts?.keywordOpps,
      },
      {
        slug: "analytics",
        label: "Analytics",
        activePrefixes: [`${base}/analytics`],
      },
      {
        slug: "screenshots",
        label: "Screenshots",
        activePrefixes: [`${base}/screenshots`],
      },
      {
        slug: "previews",
        label: "Previews",
        activePrefixes: [`${base}/previews`],
      },
      {
        slug: "deploy",
        label: "Deploy",
        activePrefixes: [`${base}/deploy`],
      },
      {
        // "Release" merges the binary builds + the submit-for-review workflow —
        // they're two halves of getting one version to the store. Sits after
        // Deploy: build/upload first, then release/submit.
        slug: "builds",
        label: "Release",
        activePrefixes: [`${base}/builds`, `${base}/submission`],
      },
      {
        slug: "history",
        label: "History",
        activePrefixes: [`${base}/history`, `${base}/library`],
      },
    ],
    [base, counts?.keywordOpps, counts?.pulseAlarms, counts?.studioDirty],
  );

  return (
    <nav
      aria-label="App sections"
      // `scroll-fine` + overflow-x-auto: on narrow viewports the 5+
      // pill tabs would otherwise force the whole page wider than the
      // viewport. Horizontal scroll within the nav itself keeps the
      // page width honest. `max-w-full` caps the inline-flex so the
      // nav can't push past its container.
      className="scroll-fine inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-[var(--radius-pill)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-1"
    >
      {tabs.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const isActive = tab.activePrefixes.some(
          (p) => pathname === p || pathname.startsWith(`${p}/`),
        );
        return (
          <Link
            key={tab.slug}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5",
              "text-[13px] font-medium outline-none transition-all duration-150",
              "focus-visible:ring-2 focus-visible:ring-[var(--signal)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-paper)]",
              isActive
                ? "bg-[var(--ink-primary)] text-[var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
            )}
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge > 0 ? (
              <span
                className={cn(
                  "inline-flex min-w-[18px] items-center justify-center rounded-[var(--radius-pill)] px-1.5 text-[10px] font-semibold tabular-nums leading-tight",
                  isActive
                    ? "bg-[var(--surface-elevated)]/20 text-[var(--surface-elevated)]"
                    : "bg-[var(--signal-tint)] text-[var(--signal)]",
                )}
              >
                {tab.badge > 99 ? "99+" : tab.badge.toString()}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
