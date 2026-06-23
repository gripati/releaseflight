"use client";
import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  src: string;
  fileName: string;
  meta: string;
  onClose: () => void;
}

export function Lightbox({ src, fileName, meta, onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--ink-primary)]/85 backdrop-blur-[6px]"
    >
      <header className="absolute left-0 right-0 top-0 flex items-center justify-between p-4">
        <div>
          <p className="font-mono text-[11px] text-[var(--surface-paper)]/80">{fileName}</p>
          <p className="font-mono text-[10px] text-[var(--surface-paper)]/60">{meta}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-[var(--surface-paper)]/10 p-2 text-[var(--surface-paper)] hover:bg-[var(--surface-paper)]/20"
        >
          <X size={16} />
        </button>
      </header>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={fileName}
        className="max-h-[88vh] max-w-[88vw] object-contain motion-safe:animate-[editorial-reveal_400ms_cubic-bezier(0.16,1,0.3,1)_both]"
      />
    </div>
  );
}
