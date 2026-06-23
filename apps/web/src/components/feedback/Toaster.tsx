"use client";
import { Toaster as SonnerToaster, toast } from "sonner";

/**
 * Editorial-flavoured toast surface. Sonner styles are stripped via
 * `unstyled: true`; we apply our token classes manually so light/dark
 * themes flow through.
 */
export function Toaster(): JSX.Element {
  return (
    <SonnerToaster
      position="top-right"
      // Header is a fixed 56px bar (z-30). A 16px top offset tucked toasts UNDER
      // it; clear the header (56 + 16) so they float in the content area, and pin
      // the stack above every chrome layer so nothing can ever cover a toast.
      // mobileOffset matches — sonner otherwise resets to 16px top below 600px,
      // which would slide toasts back under the header on phones.
      offset={{ top: 72, right: 16 }}
      mobileOffset={{ top: 72, right: 16 }}
      style={{ zIndex: 2147483647 }}
      gap={8}
      toastOptions={{
        unstyled: true,
        duration: 5000,
        classNames: {
          toast:
            "flex w-[360px] gap-3 rounded-[var(--radius)] border-l-2 bg-[var(--surface-elevated)] px-4 py-3 shadow-[var(--shadow-popover)]",
          success: "border-l-[var(--status-success)]",
          error: "border-l-[var(--status-danger)]",
          warning: "border-l-[var(--status-warning)]",
          info: "border-l-[var(--status-info)]",
          title: "font-body text-[13px] font-medium text-[var(--ink-primary)]",
          description: "mt-1 font-body text-[12px] text-[var(--ink-secondary)]",
          actionButton:
            "rounded-[var(--radius-xs)] bg-[var(--ink-primary)] px-2 py-1 font-body text-[12px] text-[var(--surface-paper)]",
          cancelButton:
            "rounded-[var(--radius-xs)] px-2 py-1 font-body text-[12px] text-[var(--ink-secondary)]",
          closeButton: "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
        },
      }}
    />
  );
}

export { toast };
