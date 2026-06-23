"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@marquee/ui";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  side?: "right";
  width?: number;
  children: React.ReactNode;
}

/**
 * Right-side drawer rendered through a React Portal directly into
 * `document.body`. We MUST portal because any transformed ancestor
 * (e.g. `.page-loaded > *` runs the editorial-reveal animation which
 * leaves a `transform` style applied) creates a CSS containing block
 * that pins `position: fixed` to itself instead of the viewport — that
 * was the "sheet appears inline mid-page / form gets clipped" bug.
 *
 * Behaviour:
 *   • Esc key closes
 *   • Body scroll-lock while open
 *   • Backdrop click closes
 *   • Aside is a flex column: sticky header + scrollable body
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  width = 560,
  children,
}: SheetProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "sheet-title" : undefined}
      className="fixed inset-0 z-[100] flex justify-end"
      style={{ isolation: "isolate" }}
    >
      <button
        type="button"
        aria-label="Close sheet"
        onClick={onClose}
        className="absolute inset-0 bg-[var(--ink-primary)]/40 backdrop-blur-[3px]"
      />
      <aside
        style={{ width, maxWidth: "min(100vw, 720px)" }}
        className={cn(
          "relative flex h-full flex-col bg-[var(--surface-elevated)] shadow-[var(--shadow-modal)]",
          "border-l-[0.5px] border-[var(--stroke-default)]",
          "motion-safe:animate-[editorial-reveal_300ms_cubic-bezier(0.16,1,0.3,1)_both]",
        )}
      >
        {(title || subtitle) && (
          <header className="sticky top-0 z-10 shrink-0 border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-8 pb-4 pt-8">
            {title && (
              <h2
                id="sheet-title"
                className="font-display text-2xl tracking-[-0.01em]"
                style={{ fontVariationSettings: "'wght' 600" }}
              >
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 font-body text-[13px] text-[var(--ink-secondary)]">{subtitle}</p>
            )}
          </header>
        )}
        <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
      </aside>
    </div>
  );

  return createPortal(overlay, document.body);
}
