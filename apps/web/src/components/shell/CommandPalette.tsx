"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
// cmdk's Command.Dialog renders a Radix Dialog under the hood; Radix requires a
// DialogTitle for screen-reader accessibility. Import the Title from the SAME
// @radix-ui/react-dialog instance cmdk uses (pnpm dedupes to one), so it shares
// the dialog context and registers correctly.
import { Title as DialogTitle } from "@radix-ui/react-dialog";
import {
  Package,
  ShieldCheck,
  History,
  Armchair,
  Settings,
  CircleDot,
  Search,
  LogOut,
  Plus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@marquee/ui";
import { AppleLogo, GooglePlayLogo } from "@/components/icons/BrandIcons";
import { api } from "@/lib/apiClient";

/** Any icon that takes `size` + `className` — lucide icons (forwardRef) OR our
 *  plain-function brand marks. A union keeps both assignable without a cast. */
type IconComponent = LucideIcon | ((props: { size?: number; className?: string }) => JSX.Element);

interface AppEntry {
  id: string;
  appName: string;
  platform: string;
  bundleId: string | null;
}

export interface CommandTarget {
  tenantSlug: string;
  /** Offer the Seats (members) entry — only for multi-seat / unlimited licences. */
  showSeats: boolean;
  /** Controlled open state — owned by the always-mounted CommandPaletteButton
   *  so this (cmdk + radix-dialog) chunk only loads on first ⌘K / click. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cmd+K command palette. Lists workspace navigation, quick actions and
 * (eventually) a fuzzy-search of apps by name. Powered by cmdk.
 *
 * Lazy-loaded via next/dynamic from CommandPaletteButton — the ⌘K listener
 * and open-state live in that tiny always-mounted button, so cmdk and
 * @radix-ui/react-dialog stay out of the per-page shell bundle until the
 * palette is first opened. Radix's Dialog handles Escape via onOpenChange.
 */
export function CommandPalette({ tenantSlug, showSeats, open, onOpenChange }: CommandTarget): JSX.Element {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppEntry[]>([]);
  const loadedRef = useRef(false);

  // Pull the tenant's apps the first time the palette opens so they're
  // searchable by name or bundle id. Cached for the session — reopening is
  // instant; a failed load is allowed to retry on the next open.
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      const res = await api<{ apps: AppEntry[] }>("/api/v1/apps");
      if (res.ok) setApps(res.data.apps);
      else loadedRef.current = false;
    })();
  }, [open]);

  function go(path: string): void {
    onOpenChange(false);
    router.push(path);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-[60] flex items-start justify-center"
    >
      {/* Visually-hidden accessible title required by Radix Dialog. */}
      <DialogTitle
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        Command palette
      </DialogTitle>
      <div
        aria-hidden
        className="absolute inset-0 bg-[var(--ink-primary)]/30 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
      />
      <div className="relative mt-[15vh] w-[640px] max-w-[90vw] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-elevated)] shadow-[var(--shadow-modal)] motion-safe:animate-[editorial-reveal_240ms_cubic-bezier(0.16,1,0.3,1)_both]">
        <div className="flex items-center gap-2 border-b-[0.5px] border-[var(--stroke-default)] px-4">
          <Search size={14} className="text-[var(--ink-tertiary)]" />
          <Command.Input
            placeholder="Search apps, pages, actions…"
            value={query}
            onValueChange={setQuery}
            // The global unlayered `:focus-visible` rule (globals.css) paints a 2px
            // orange ring and OUTRANKS any Tailwind outline utility — those live in
            // `@layer utilities`, which the cascade ranks below unlayered rules. An
            // inline style is the only reliable override; the dialog already frames
            // the field, so no ring is needed.
            style={{ outline: "none" }}
            className="h-12 flex-1 bg-transparent font-body text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-tertiary)]"
          />
          <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">esc</span>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto py-2">
          <Command.Empty className="px-4 py-6 text-center font-body text-[13px] text-[var(--ink-tertiary)]">
            No matches.
          </Command.Empty>

          {apps.length > 0 && (
            <Group heading="Apps">
              {apps.map((a) => (
                <Item
                  key={a.id}
                  icon={a.platform === "IOS" ? AppleLogo : GooglePlayLogo}
                  // Explicit value → unique (ids) + searchable by name AND bundle id.
                  value={`${a.appName} ${a.bundleId ?? ""} ${a.id}`}
                  hint={a.bundleId ?? undefined}
                  onSelect={() => go(`/t/${tenantSlug}/apps/${a.id}/pulse`)}
                >
                  {a.appName}
                </Item>
              ))}
            </Group>
          )}

          <Group heading="Navigate">
            {/* "Dashboard" used to live at the top here, with `g d`. It was
                retired alongside the /dashboard route — Apps is now the
                canonical workspace landing, so it inherits both the
                top slot and the muscle-memory `g a` shortcut. */}
            <Item icon={Package} onSelect={() => go(`/t/${tenantSlug}/apps`)} shortcut="g a">
              Apps
            </Item>
            <Item icon={ShieldCheck} onSelect={() => go(`/t/${tenantSlug}/credentials`)}>
              Credentials
            </Item>
            <Item icon={CircleDot} onSelect={() => go(`/t/${tenantSlug}/jobs`)}>
              Jobs
            </Item>
            <Item icon={History} onSelect={() => go(`/t/${tenantSlug}/audit`)}>
              History
            </Item>
            {showSeats ? (
              <Item icon={Armchair} onSelect={() => go(`/t/${tenantSlug}/seats`)}>
                Seats
              </Item>
            ) : null}
            <Item icon={Settings} onSelect={() => go(`/t/${tenantSlug}/settings`)} shortcut="g s">
              Settings
            </Item>
          </Group>

          <Group heading="Actions">
            <Item icon={Plus} onSelect={() => go(`/t/${tenantSlug}/apps`)}>
              Connect a new app
            </Item>
            <Item
              icon={LogOut}
              onSelect={() => {
                const f = document.createElement("form");
                f.method = "POST";
                f.action = "/api/v1/auth/logout";
                document.body.appendChild(f);
                f.submit();
              }}
            >
              Sign out
            </Item>
          </Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Group({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Command.Group
      heading={heading}
      className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  icon: Icon,
  onSelect,
  shortcut,
  hint,
  value,
  children,
}: {
  icon: IconComponent;
  onSelect: () => void;
  /** Keyboard shortcut badge (e.g. "g a"). */
  shortcut?: string;
  /** Muted right-aligned context (e.g. an app's bundle id). */
  hint?: string;
  /** Explicit cmdk filter/match value. Defaults to the rendered text. */
  value?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[var(--radius-xs)] px-3 py-2 text-[13px]",
        "text-[var(--ink-primary)] aria-[selected=true]:bg-[var(--signal-tint)]",
        "data-[selected=true]:bg-[var(--signal-tint)] hover:bg-[var(--surface-tinted)]",
      )}
    >
      <Icon size={14} className="shrink-0 text-[var(--ink-tertiary)]" />
      <span className="flex-1 truncate">{children}</span>
      {hint && (
        <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-[var(--ink-tertiary)]">
          {hint}
        </span>
      )}
      {shortcut && (
        <span className="shrink-0 font-mono text-[10px] text-[var(--ink-tertiary)]">{shortcut}</span>
      )}
    </Command.Item>
  );
}
