/**
 * Real platform brand marks, used wherever the UI denotes a store/platform:
 *   • AppleLogo      — monochrome Apple silhouette (inherits currentColor, so it
 *                      adapts to light/dark + the surrounding text colour).
 *   • GooglePlayLogo — the iconic 4-colour Google Play "play" triangle.
 *
 * Drop-in compatible with lucide icons (accept `size` + `className`), so they
 * can be passed wherever a `LucideIcon` was used. Decorative by default
 * (aria-hidden) — they always sit next to a text label ("iOS" / "Android").
 */
import type { JSX } from "react";

export interface BrandIconProps {
  size?: number;
  className?: string;
}

/** Apple Inc. logo — monochrome, fills currentColor. */
export function AppleLogo({ size = 24, className }: BrandIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18.71,19.5C17.88,20.74 17,21.95 15.66,21.97C14.32,22 13.89,21.18 12.37,21.18C10.84,21.18 10.37,21.95 9.1,22C7.79,22.05 6.8,20.68 5.96,19.47C4.25,17 2.94,12.45 4.7,9.39C5.57,7.87 7.13,6.91 8.82,6.88C10.1,6.86 11.32,7.75 12.11,7.75C12.89,7.75 14.37,6.68 15.92,6.84C16.57,6.87 18.39,7.1 19.56,8.82C19.47,8.88 17.39,10.1 17.41,12.63C17.44,15.65 20.06,16.66 20.09,16.67C20.06,16.74 19.67,18.11 18.71,19.5M13,3.5C13.73,2.67 14.94,2.04 15.94,2C16.07,3.17 15.6,4.35 14.9,5.19C14.21,6.04 13.07,6.7 11.95,6.61C11.8,5.46 12.36,4.26 13,3.5Z" />
    </svg>
  );
}

/** Google Play logo — the four-colour "play" triangle. */
export function GooglePlayLogo({ size = 24, className }: BrandIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* left spine — blue */}
      <path
        fill="#00C3FF"
        d="M3 20.5V3.5C3 2.91 3.34 2.39 3.84 2.15L13.69 12 3.84 21.85C3.34 21.6 3 21.09 3 20.5Z"
      />
      {/* top facet — green */}
      <path fill="#00F076" d="M6.05 2.66 16.81 8.88 14.54 11.15 6.05 2.66Z" />
      {/* bottom facet — red */}
      <path fill="#FF3A44" d="M16.81 15.12 6.05 21.34 14.54 12.85 16.81 15.12Z" />
      {/* right tip — yellow */}
      <path
        fill="#FFD400"
        d="M20.16 10.81C20.5 11.08 20.75 11.5 20.75 12C20.75 12.5 20.5 12.92 20.16 13.19L17.89 14.5 15.39 12 17.89 9.5 20.16 10.81Z"
      />
    </svg>
  );
}

/** Convenience: pick the brand mark for a platform value. */
export function PlatformIcon({
  platform,
  size = 16,
  className,
}: {
  platform: string;
  size?: number;
  className?: string;
}): JSX.Element {
  return platform === "IOS" ? (
    <AppleLogo size={size} className={className} />
  ) : (
    <GooglePlayLogo size={size} className={className} />
  );
}
