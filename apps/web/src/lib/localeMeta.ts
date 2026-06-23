/**
 * Thin wrapper around @marquee/core's canonical locale helpers.
 *
 * Single source of truth lives in `@marquee/core/locale` — we just
 * project flag + name + region into one struct here for ergonomics on
 * the React side.
 */
import { localeName, localeFlag, localeRegion } from "@marquee/core/locale";

export interface LocaleMeta {
  /** The canonical locale string we were given. */
  locale: string;
  /** English language name, App Store-style. */
  name: string;
  /** ISO 3166-1 alpha-2 region (uppercase). */
  region: string;
  /** Unicode flag emoji, e.g. 🇹🇷. */
  flag: string;
}

export function localeMeta(locale: string): LocaleMeta {
  return {
    locale,
    name: localeName(locale),
    region: localeRegion(locale),
    flag: localeFlag(locale),
  };
}
