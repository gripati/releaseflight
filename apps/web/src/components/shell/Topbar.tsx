import Link from "next/link";
import { LogOut } from "lucide-react";
import { cn } from "@marquee/ui";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { CommandPaletteButton } from "./CommandPaletteButton";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export interface TopbarProps {
  tenantName: string;
  tenantSlug: string;
  userDisplayName: string;
  userEmail: string;
  /** Whether the command palette should offer the Seats (members) entry. */
  showSeats: boolean;
}

export function Topbar({
  tenantName,
  tenantSlug,
  userDisplayName,
  userEmail,
  showSeats,
}: TopbarProps): JSX.Element {
  // Solid background + no backdrop-blur — keeps the topbar stable
  // behind anchored popovers like the notification bell (blur on the
  // topbar would create stacking-context surprises).
  return (
    <header
      // position/z via inline style: globals.css forces `header { position:
      // relative; z-index: 2 }` (unlayered element rule) which would override a
      // Tailwind `fixed` utility — inline style wins, keeping the bar truly fixed.
      style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 30 }}
      className="flex h-14 items-center border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-paper)] px-6"
    >
      <Link
        href={`/t/${tenantSlug}/apps`}
        className="font-wordmark text-[19px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]"
      >
        Release Flight
      </Link>

      <span className="mx-4 text-[var(--ink-quaternary)]" aria-hidden>
        ·
      </span>

      <Link
        href={`/t/${tenantSlug}/apps`}
        className={cn(
          "flex items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1",
          "hover:bg-[var(--surface-tinted)] transition-colors",
        )}
        title={`Workspace: ${tenantName}`}
      >
        <span className="font-display text-sm">{tenantName.charAt(0).toUpperCase()}</span>
        <span className="font-body text-[13px] font-medium">{tenantName}</span>
        <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">/{tenantSlug}</span>
      </Link>

      <div className="ml-auto flex items-center gap-2">
        <CommandPaletteButton tenantSlug={tenantSlug} showSeats={showSeats} />
        <NotificationBell tenantSlug={tenantSlug} />
        <ThemeSwitcher />
        <div
          className="flex items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1"
          title={userEmail}
        >
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--ink-primary)] text-[10px] font-medium text-[var(--surface-paper)]">
            {userDisplayName.charAt(0).toUpperCase()}
          </span>
          <span className="hidden font-body text-[13px] sm:block">{userDisplayName}</span>
        </div>
        <form action="/api/v1/auth/logout" method="POST">
          <button
            type="submit"
            aria-label="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-xs)] text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]"
          >
            <LogOut size={14} />
          </button>
        </form>
      </div>
    </header>
  );
}
