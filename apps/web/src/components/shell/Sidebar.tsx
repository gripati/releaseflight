"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Package,
  ShieldCheck,
  History,
  Armchair,
  Settings,
  CircleDot,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn, Divider } from "@marquee/ui";

export interface SidebarProps {
  tenantSlug: string;
  /** Optional sidebar counters loaded by parent layout */
  counts?: { apps?: number; jobs?: number; dirty?: number };
  /** Show the Seats (members + seats) entry — only for multi-seat / unlimited licences. */
  showSeats?: boolean;
  /** Release version (from CI) shown in the footer; null on dev builds. */
  appVersion?: string | null;
}

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  badge?: string | number | undefined;
}

export function Sidebar({ tenantSlug, counts, showSeats, appVersion }: SidebarProps): JSX.Element {
  const base = `/t/${tenantSlug}`;
  // Active state is derived client-side from usePathname() (like AppShellNav)
  // so the highlight is always correct and the shell layout no longer needs
  // a per-request `x-pathname` header (which was never set) — that header
  // read was the only thing forcing the tenant layout to `force-dynamic`,
  // and dropping it lets the App Router prefetch sidebar destinations.
  const activePath = usePathname() ?? base;
  // Two retirements live here:
  //   • The tenant-wide "Dashboard" entry — once the post-login
  //     landing, but its KPI-grid duplicated per-app Pulse + Apps
  //     stats. Operators went to /apps next anyway, so /apps is now
  //     the canonical first surface and Dashboard is gone.
  //   • The tenant-wide "ASO" portfolio entry — every ASO surface
  //     now belongs to a specific app (Pulse, Keywords). A workspace
  //     shortcut implied a cross-app summary that was really just N
  //     Pulses glued together.
  // "Team" was folded into "Seats": one page manages members AND seats. The entry
  // shows only when the licence has a team to manage (multi-seat / unlimited).
  const items: NavItem[] = [
    { href: `${base}/apps`, label: "Apps", Icon: Package, badge: counts?.apps },
    { href: `${base}/credentials`, label: "Credentials", Icon: ShieldCheck },
    { href: `${base}/jobs`, label: "Jobs", Icon: CircleDot, badge: counts?.jobs },
    { href: `${base}/audit`, label: "History", Icon: History },
    ...(showSeats ? [{ href: `${base}/seats`, label: "Seats", Icon: Armchair }] : []),
  ];

  return (
    <aside
      aria-label="Workspace navigation"
      // FIXED below the topbar (h-14 = 3.5rem) so it never scrolls with the
      // page. position/z are set inline because globals.css forces
      // `aside { position: relative; z-index: 2 }` which would override a
      // Tailwind `fixed` utility. Hidden under md (768 px) — mobile users get
      // the full viewport; width is mirrored by `md:pl-60` on <main>.
      style={{ position: "fixed", top: "3.5rem", left: 0, zIndex: 20 }}
      className="hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col overflow-y-auto border-r-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] px-3 py-6 md:flex"
    >
      <nav className="flex flex-col gap-px">
        {items.map((item) => {
          const isActive = activePath === item.href || activePath.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-2 rounded-[var(--radius-xs)] px-3 py-2 text-[13px] font-body",
                "transition-colors duration-100",
                isActive
                  ? "bg-[var(--signal-tint)] text-[var(--ink-primary)]"
                  : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--signal)] transition-opacity duration-100",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
              <item.Icon
                size={14}
                className={isActive ? "text-[var(--signal)]" : "text-[var(--ink-tertiary)]"}
              />
              <span className="flex-1">{item.label}</span>
              {item.badge !== undefined && item.badge !== 0 ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                    isActive
                      ? "bg-[var(--signal)] text-[var(--signal-on)]"
                      : "bg-[var(--surface-sunken)] text-[var(--ink-secondary)]",
                  )}
                >
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <Divider className="my-4" />

      {(() => {
        const settingsHref = `${base}/settings`;
        const settingsActive =
          activePath === settingsHref || activePath.startsWith(`${settingsHref}/`);
        return (
          <Link
            href={settingsHref}
            aria-current={settingsActive ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-2 rounded-[var(--radius-xs)] px-3 py-2 text-[13px] font-body",
              "transition-colors duration-100",
              settingsActive
                ? "bg-[var(--signal-tint)] text-[var(--ink-primary)]"
                : "text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--signal)] transition-opacity duration-100",
                settingsActive ? "opacity-100" : "opacity-0",
              )}
            />
            <Settings
              size={14}
              className={settingsActive ? "text-[var(--signal)]" : "text-[var(--ink-tertiary)]"}
            />
            Settings
          </Link>
        );
      })()}

      <div className="mt-auto text-[10px] text-[var(--ink-tertiary)]">
        <span className="inline-flex items-center gap-2">
          <span
            className="block h-1.5 w-1.5 rounded-full bg-[var(--status-success)]"
            aria-hidden
          />
          {appVersion ? (
            <span className="font-mono tabular-nums" title={`Release Flight v${appVersion}`}>
              v{appVersion}
            </span>
          ) : (
            <span className="uppercase tracking-[0.08em]">All systems normal</span>
          )}
        </span>
      </div>
    </aside>
  );
}
