import { Sidebar, type SidebarProps } from "./Sidebar";
import { Topbar, type TopbarProps } from "./Topbar";
import { LicenseBanner } from "@/components/license/LicenseBanner";

export interface TenantShellProps {
  topbar: TopbarProps;
  sidebar: SidebarProps;
  children: React.ReactNode;
  /** Tenant slug forwarded to LicenseBanner for the license-settings link. */
  tenantSlug: string;
}

/**
 * Shell layout — topbar + sidebar + main content area.
 *
 * Responsive contract:
 *   • Sidebar hides under the `md` breakpoint (<768 px). Mobile users
 *     get the full viewport for content; the topbar's CommandPalette
 *     covers nav until a hamburger drawer ships.
 *   • Main padding scales with viewport: 16 → 24 → 40 → 56 px from
 *     `px-4` → `lg:px-10` → `xl:px-14`. Saves precious horizontal
 *     space on phones and tablets, breathes on big monitors.
 *   • `min-w-0` on the inner wrapper is critical — without it flex children
 *     inside the page (LocaleStrip overflow, horizontal screenshot
 *     strips, etc.) couldn't shrink below their intrinsic content
 *     width and the whole page would scroll horizontally.
 *
 * The Topbar (h-14) and Sidebar (w-60) are `fixed`, so they never scroll
 * with the page. `<main>` clears them with `pt-14` (header) + `md:pl-60`
 * (sidebar); only the content area scrolls.
 */
export function TenantShell({ topbar, sidebar, children, tenantSlug }: TenantShellProps): JSX.Element {
  return (
    <div className="min-h-screen bg-[var(--surface-paper)] text-[var(--ink-primary)]">
      <Topbar {...topbar} />
      <Sidebar {...sidebar} />
      <main id="main-content" className="min-h-screen w-full pt-14 md:pl-60">
        <div className="mx-auto w-full min-w-0 max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10 xl:px-14">
          {/* Client island — renders nothing for dev / healthy installs */}
          <LicenseBanner tenantSlug={tenantSlug} />
          {children}
        </div>
      </main>
    </div>
  );
}
