"use client";
import { Command as CommandIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * The palette itself (cmdk + @radix-ui/react-dialog, ~15-30KB gz) is loaded
 * on demand: this tiny button stays mounted on every dashboard page, owns the
 * ⌘K shortcut + open state, and only renders <CommandPalette> after the first
 * open — so the palette's chunk never parses/hydrates until it's actually used.
 */
const CommandPalette = dynamic(
  () => import("./CommandPalette").then((m) => m.CommandPalette),
  { ssr: false },
);

export function CommandPaletteButton({
  tenantSlug,
  showSeats,
}: {
  tenantSlug: string;
  showSeats: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Once opened we keep it mounted so re-opening is instant.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setMounted(true);
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Open command palette (⌘K)"
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        className="flex items-center gap-2 rounded-[var(--radius-xs)] border border-[var(--stroke-default)] px-2 py-1 text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]"
      >
        <CommandIcon size={12} />
        <span className="font-mono text-[10px]">⌘K</span>
      </button>
      {mounted ? (
        <CommandPalette tenantSlug={tenantSlug} showSeats={showSeats} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}
