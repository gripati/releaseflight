"use client";
import { useEffect, useState } from "react";
import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { cn } from "@marquee/ui";

type Theme = "light" | "dark" | "system";

const KEY = "gp-theme";

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

/**
 * Theme picker with a radial reveal on switch. Persists choice in
 * localStorage; honours `prefers-color-scheme` when set to system.
 */
export function ThemeSwitcher(): JSX.Element {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY) as Theme | null;
      if (stored === "light" || stored === "dark" || stored === "system") {
        setTheme(stored);
        applyTheme(stored);
      }
    } catch {
      /* private mode etc. */
    }
  }, []);

  function setAndPersist(next: Theme, anchor?: { x: number; y: number }): void {
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    // Radial reveal animation — paint a clip-path circle that expands from
    // the click point. We do this via a one-off CSS animation on a clone
    // wrapper element so the underlying app re-renders smoothly.
    if (anchor && document.startViewTransition) {
      const transition = document.startViewTransition(() => {
        applyTheme(next);
      });
      transition.ready.then(() => {
        const radius = Math.hypot(
          Math.max(anchor.x, window.innerWidth - anchor.x),
          Math.max(anchor.y, window.innerHeight - anchor.y),
        );
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${anchor.x}px ${anchor.y}px)`,
              `circle(${radius}px at ${anchor.x}px ${anchor.y}px)`,
            ],
          },
          { duration: 500, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      }).catch(() => {
        /* fallback to instant apply */
      });
      return;
    }
    applyTheme(next);
  }

  const options: { id: Theme; Icon: typeof Sun; label: string }[] = [
    { id: "light", Icon: Sun, label: "Light" },
    { id: "dark", Icon: Moon, label: "Dark" },
    { id: "system", Icon: MonitorSmartphone, label: "System" },
  ];

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0 rounded-[var(--radius-xs)] border border-[var(--stroke-default)] p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={theme === opt.id}
          aria-label={opt.label}
          onClick={(e) =>
            setAndPersist(opt.id, { x: e.clientX, y: e.clientY })
          }
          className={cn(
            "rounded-[var(--radius-xs)] p-1.5 transition-colors",
            theme === opt.id
              ? "bg-[var(--surface-tinted)] text-[var(--ink-primary)]"
              : "text-[var(--ink-tertiary)] hover:text-[var(--ink-primary)]",
          )}
        >
          <opt.Icon size={12} />
        </button>
      ))}
    </div>
  );
}
