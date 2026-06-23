"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { Button, Spinner, cn } from "@marquee/ui";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "destructive" | "warning" | "info";
  /** Set to true while the action runs — disables both buttons + shows spinner. */
  pending?: boolean;
}

/**
 * Shared modal confirm — replaces the native `confirm()` everywhere so we
 * get themed visuals, focus-trapped buttons, Esc-to-cancel, portal
 * rendering (escapes transformed ancestors) and a "pending" state that
 * shows a spinner inside the confirm button.
 *
 * Use this for any irreversible / sensitive action: delete, leave, push
 * with overwrite, submit for review, etc.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "destructive",
  pending = false,
}: ConfirmDialogProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, pending]);

  if (!mounted || !open) return null;

  const iconColor =
    variant === "destructive"
      ? "var(--status-danger)"
      : variant === "warning"
        ? "var(--status-warning)"
        : "var(--status-info)";

  const overlay = (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-[110] flex items-center justify-center"
      style={{ isolation: "isolate" }}
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => !pending && onClose()}
        className="absolute inset-0 bg-[var(--ink-primary)]/45 backdrop-blur-[3px]"
      />
      <div
        className={cn(
          "relative w-[min(440px,90vw)] rounded-[var(--radius-lg)] bg-[var(--surface-elevated)] p-6 shadow-[var(--shadow-modal)]",
          "motion-safe:animate-[editorial-reveal_220ms_cubic-bezier(0.16,1,0.3,1)_both]",
        )}
      >
        <AlertTriangle size={20} style={{ color: iconColor }} aria-hidden />
        <h3
          id="confirm-title"
          className="mt-3 font-display text-xl tracking-[-0.01em]"
          style={{ fontVariationSettings: "'wght' 600" }}
        >
          {title}
        </h3>
        {description && (
          <div className="mt-2 font-body text-[13px] leading-[1.55] text-[var(--ink-secondary)]">
            {description}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "info" ? "primary" : "destructive"}
            onClick={() => {
              void onConfirm();
            }}
            disabled={pending}
            autoFocus
          >
            {pending ? <Spinner size={12} /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
  return createPortal(overlay, document.body);
}
