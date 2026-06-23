"use client";

/**
 * FieldHint — lightbulb icon that opens a tooltip with platform-aware
 * field guidance. Hover / focus to open; click to pin (mobile-friendly);
 * ESC + outside-click to dismiss.
 *
 * Why this exists: the inline `<p>{help}</p>` strings under each field
 * felt like UI noise once the editor settled into its compact layout.
 * Moving the content into an on-demand tooltip keeps the canvas calm
 * while letting operators drill into Apple- / Google-specific copy
 * advice when they need it.
 *
 * The hint registry lives below — one map per platform, keyed by the
 * AppLocalization column name. Add new entries here when a new field
 * lands; the FieldRow looks up by `field` + `platform` automatically.
 */
import { useEffect, useRef, useState } from "react";
import { Lightbulb } from "lucide-react";
import { cn } from "@marquee/ui";

type Platform = "IOS" | "ANDROID";

export interface HintContent {
  /** One-line summary shown at the top of the tooltip (bold). */
  summary: string;
  /** 2-4 actionable bullets — each renders on its own line. */
  bullets: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Per-platform hint registry
// ──────────────────────────────────────────────────────────────────────
//
// Keyed by AppLocalization column name. Entries that don't apply to a
// platform return `null` and the FieldHint silently renders nothing
// (the lightbulb only shows when there's content to surface).

const HINTS_IOS: Record<string, HintContent> = {
  name: {
    summary: "Title — Apple's heaviest-weighted ranking signal.",
    bullets: [
      "First 23 characters show in search-result rows — front-load the unique brand noun.",
      "Indexed at the HIGHEST weight in Apple's search algorithm — every word here is a keyword.",
      "Never repeat title words inside Subtitle or Keywords field — duplicate indexing wastes Apple's budget.",
    ],
  },
  subtitle: {
    summary: "Subtitle — 30 free keyword bytes (iOS only).",
    bullets: [
      "Indexed at the SAME weight as the keywords field — treat it like prime keyword real estate.",
      "Place your secondary keyword cluster here; never echo title words.",
      "Only about 18 characters are visible on small phones above the fold — front-load.",
    ],
  },
  keywords: {
    summary: "Keywords field — 100-byte search-term budget (iOS only).",
    bullets: [
      "Comma-separated with NO spaces between (each space is one wasted byte).",
      "Never include words already in Title or Subtitle — that's duplicate indexing.",
      "Apple's tokenizer skips stop words (the, a, for, in) — drop them entirely.",
    ],
  },
  promotionalText: {
    summary: "Promotional text — instant deploy, not indexed.",
    bullets: [
      "NOT indexed for search — pure conversion lever sitting on top of the description.",
      "Updates push to App Store WITHOUT going through App Review — ideal for sales, events, social proof.",
      "Shows above the description in the expanded product page view.",
    ],
  },
  description: {
    summary: "Description — conversion copy, barely indexed.",
    bullets: [
      "Apple barely indexes the description for search — minimal ASO ranking impact, pure conversion lever.",
      "First ~170 characters preview above the fold (under Promotional text) — front-load benefits + a clear hook.",
      "Apple respects line breaks — use short paragraphs and bullet markers (•, ★) so users can skim.",
    ],
  },
  whatsNew: {
    summary: "What's new — per-version release notes.",
    bullets: [
      "Shown on update prompts when users see your app has a new version.",
      "Apple respects line breaks; format with bullets or numbered points.",
      "Don't repeat the previous version's notes — returning users notice.",
    ],
  },
  marketingUrl: {
    summary: "Marketing URL — optional outbound link.",
    bullets: [
      "Optional. Surfaces on the product page; taps leave the App Store.",
      "Use a campaign-friendly landing page that matches your store positioning.",
      "Must be HTTPS with valid SSL.",
    ],
  },
  supportUrl: {
    summary: "Support URL — public help endpoint.",
    bullets: [
      "Should resolve to a public help page (no login wall).",
      "Apple reviewers may visit this during App Review — broken links delay submissions.",
      "Must be HTTPS with valid SSL.",
    ],
  },
  privacyPolicyUrl: {
    summary: "Privacy policy URL — REQUIRED by Apple.",
    bullets: [
      "Required by App Store Connect — submissions rejected without one.",
      "Must be HTTPS, publicly accessible, no login wall.",
      "Update whenever data practices change — Apple checks on each review.",
    ],
  },
};

const HINTS_ANDROID: Record<string, HintContent> = {
  name: {
    summary: "Title — Google Play's strongest ranking signal.",
    bullets: [
      "Google Play indexes the title at the highest keyword weight — choose your most valuable theme.",
      "Compact listings (search, Discover feed) show the first 30 characters — pack the hook there.",
      "Localized titles are indexed INDEPENDENTLY per market — translate freely without losing rank.",
    ],
  },
  shortDescription: {
    summary: "Short description — above-the-fold hook (Google Play only).",
    bullets: [
      "Shows above the fold on every listing — sells the install before the user taps More.",
      "Indexed by Google Play search — pack one secondary keyword cluster naturally.",
      "Localize per market; the hook lands different in each language.",
    ],
  },
  description: {
    summary: "Description — full keyword-density indexing.",
    bullets: [
      "Google Play indexes the FULL description with keyword-density signals — write for humans AND search.",
      "First 80 characters sit above the fold — that's your conversion hook.",
      "Mention each target keyword 3-5 times naturally throughout the body.",
    ],
  },
  videoUrl: {
    summary: "YouTube video — conversion booster.",
    bullets: [
      "Optional but proven to boost conversion when the video is tight.",
      "Use a YouTube URL — Google Play renders it inline on the listing.",
      "Keep the video under 30 seconds for store context.",
    ],
  },
  whatsNew: {
    summary: "What's new — per-version release notes.",
    bullets: [
      "Shown on update prompts when users see a new version is available.",
      "Google Play STRIPS most line breaks — write tight prose, not bullet lists.",
      "Translate per locale; users notice when notes match their language.",
    ],
  },
  marketingUrl: {
    summary: "Marketing URL — optional outbound link.",
    bullets: [
      "Optional. Shows on the listing for shareable campaign landing pages.",
      "Must be HTTPS with valid SSL.",
    ],
  },
  supportUrl: {
    summary: "Support URL — public help endpoint.",
    bullets: [
      "Should resolve to a public help page (no login wall).",
      "Surfaces in the listing footer and helps reviewers during pre-launch checks.",
      "Must be HTTPS with valid SSL.",
    ],
  },
  privacyPolicyUrl: {
    summary: "Privacy policy URL — REQUIRED by Google Play.",
    bullets: [
      "Required by Google Play Console — submissions rejected without one.",
      "Must be HTTPS, publicly accessible, no login wall.",
      "Update whenever data practices change — Google's Data Safety form references this.",
    ],
  },
};

export function getFieldHint(
  field: string,
  platform: Platform,
): HintContent | null {
  const map = platform === "IOS" ? HINTS_IOS : HINTS_ANDROID;
  return map[field] ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// FieldHint — lightbulb + tooltip
// ──────────────────────────────────────────────────────────────────────

interface FieldHintProps {
  field: string;
  platform: Platform;
  /** Override the registry — pass custom content for special cases. */
  content?: HintContent;
}

export function FieldHint({
  field,
  platform,
  content,
}: FieldHintProps): JSX.Element | null {
  const resolved = content ?? getFieldHint(field, platform);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Outside-click + ESC close (only matters when pinned via click).
  useEffect(() => {
    if (!pinned) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  if (!resolved) return null;

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={`Tips for ${field}`}
        aria-expanded={open}
        onMouseEnter={() => {
          if (!pinned) setOpen(true);
        }}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={() => {
          setPinned((p) => !p);
          // Mirror `pinned` after the toggle: hover-opened tooltips
          // collapse on click if they were pinned; otherwise click
          // pins them open until ESC / outside click dismisses.
          setOpen(!pinned);
        }}
        className={cn(
          "grid h-5 w-5 place-items-center rounded-[var(--radius-pill)] transition-colors",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)]",
          pinned || open
            ? "bg-[var(--signal-tint)] text-[var(--signal)]"
            : "text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-secondary)]",
        )}
      >
        <Lightbulb size={12} />
      </button>

      {open && (
        <div
          role="tooltip"
          className={cn(
            "absolute left-1/2 top-full z-50 mt-2 w-[320px] -translate-x-1/2",
            "rounded-[var(--radius)] border border-[var(--stroke-strong)]",
            "bg-[var(--surface-elevated)] p-3 text-left",
            "shadow-[var(--shadow-popover)]",
          )}
        >
          {/* Arrow pointing up to the lightbulb */}
          <span
            aria-hidden
            className="absolute -top-[5px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-[var(--stroke-strong)] bg-[var(--surface-elevated)]"
          />

          <p className="mb-2 flex items-start gap-1.5 text-[12.5px] font-semibold leading-snug text-[var(--ink-primary)]">
            <Lightbulb
              size={12}
              className="mt-0.5 shrink-0 text-[var(--signal)]"
            />
            {resolved.summary}
          </p>

          <ul className="flex flex-col gap-1.5">
            {resolved.bullets.map((b, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12px] leading-[1.45] text-[var(--ink-secondary)]"
              >
                <span
                  aria-hidden
                  className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--ink-tertiary)]"
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>

          {/* Platform indicator pill */}
          <p className="mt-2.5 border-t border-[var(--stroke-soft)] pt-2 text-[10px] uppercase tracking-wide text-[var(--ink-tertiary)]">
            {platform === "IOS" ? "App Store · iOS" : "Google Play · Android"}
          </p>
        </div>
      )}
    </span>
  );
}
