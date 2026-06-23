/**
 * Apple App Store locale groups — keyword pool overlap awareness.
 *
 * Apple doesn't publish their localization-grouping algorithm, but
 * empirical ASO research over the past decade has established that
 * certain locale pairs share search-result keyword pools to a
 * meaningful degree:
 *
 *   • English-speaking storefronts (US, GB, CA, AU, NZ, IE) draw
 *     from a near-shared keyword index — a term winning in en-US
 *     usually surfaces in en-GB / en-CA / en-AU within 24–48 hours.
 *   • Spanish (es-MX ↔ es-ES ↔ es-AR ↔ es-CL ↔ es-CO) — partial
 *     overlap; common Castilian terms cross over, but regional
 *     slang stays storefront-local.
 *   • French (fr-FR ↔ fr-CA ↔ fr-BE) — similar partial overlap.
 *   • Portuguese (pt-PT ↔ pt-BR) — partial overlap but the two
 *     dialects diverge enough that ranking signals don't carry
 *     fully; pro consultants still optimize them as a unit.
 *   • German (de-DE ↔ de-AT ↔ de-CH) — fully shared.
 *   • Chinese (zh-CN ↔ zh-HK ↔ zh-TW) — Hans / Hant distinction
 *     keeps them separate; we DO NOT group them.
 *
 * Use this for "this keyword is winning in en-US — also surface as
 * an opportunity in en-GB, en-CA, en-AU" cross-group recommendations
 * inside Astro Autopilot.
 *
 * The groups are CONSERVATIVE — only well-documented strong overlaps
 * are listed. A locale not in any group → its own singleton group.
 */

/** A logical locale group identifier. Members share a keyword pool. */
export type LocaleGroupId =
  | "en"
  | "es"
  | "fr"
  | "pt"
  | "de"
  | "nl"
  | "ar"
  | "sv"
  | "zh-hans"
  | "zh-hant";

/** Map of (lowercased locale code) → group id. Locales not listed
 *  here belong to their own singleton group (themselves only). */
const LOCALE_GROUPS: Record<string, LocaleGroupId> = {
  // English storefronts — strongest known overlap
  "en": "en",
  "en-us": "en",
  "en-gb": "en",
  "en-ca": "en",
  "en-au": "en",
  "en-nz": "en",
  "en-ie": "en",
  "en-za": "en",
  "en-in": "en",
  "en-sg": "en",

  // Spanish
  "es": "es",
  "es-es": "es",
  "es-mx": "es",
  "es-ar": "es",
  "es-cl": "es",
  "es-co": "es",
  "es-pe": "es",
  "es-419": "es", // Latin-American Spanish bundle code

  // French
  "fr": "fr",
  "fr-fr": "fr",
  "fr-ca": "fr",
  "fr-be": "fr",
  "fr-ch": "fr",

  // Portuguese
  "pt": "pt",
  "pt-pt": "pt",
  "pt-br": "pt",

  // German
  "de": "de",
  "de-de": "de",
  "de-at": "de",
  "de-ch": "de",

  // Dutch (NL + BE)
  "nl": "nl",
  "nl-nl": "nl",
  "nl-be": "nl",

  // Arabic (most Apple storefronts use Modern Standard Arabic)
  "ar": "ar",
  "ar-sa": "ar",
  "ar-ae": "ar",
  "ar-eg": "ar",

  // Scandinavian — historically Apple has grouped Swedish-flavoured
  // results across SE/NO/DK with looser overlap, but we keep them as
  // separate groups here because the empirical signal is weak.
  // Keeping the map ready for future tuning.
  "sv": "sv",
  "sv-se": "sv",

  // Chinese — Hans (mainland Simplified) vs Hant (Hong Kong / Taiwan
  // Traditional). DO NOT cross these.
  "zh": "zh-hans",
  "zh-hans": "zh-hans",
  "zh-cn": "zh-hans",
  "zh-hk": "zh-hant",
  "zh-tw": "zh-hant",
  "zh-hant": "zh-hant",
};

/**
 * Return the LocaleGroupId for a given locale code, or null when the
 * locale doesn't belong to any documented group (treat as singleton).
 *
 * Case-insensitive, accepts both BCP-47 (en-US) and short forms (en).
 */
export function getLocaleGroup(locale: string | null | undefined): LocaleGroupId | null {
  if (!locale) return null;
  const key = locale.toLowerCase();
  return LOCALE_GROUPS[key] ?? LOCALE_GROUPS[key.split(/[-_]/)[0] ?? ""] ?? null;
}

/**
 * Return all locales known to belong to the same group as the input.
 * Includes the input locale itself. Returns just the input when no
 * group membership is documented (singleton).
 *
 * Sorted alphabetically for stable output. Locale codes returned in
 * the canonical BCP-47 lowercase form they're stored in the map; the
 * caller can re-normalise to Apple's preferred casing (en-US) if
 * needed via `toAppleLocale`.
 */
export function getLocaleGroupMembers(locale: string | null | undefined): string[] {
  if (!locale) return [];
  const groupId = getLocaleGroup(locale);
  if (!groupId) return [locale];
  const members = Object.entries(LOCALE_GROUPS)
    .filter(([, gid]) => gid === groupId)
    .map(([loc]) => loc)
    .filter((loc) => loc.includes("-")); // Drop bare "en" alias rows
  return members.sort();
}

/**
 * Returns true when the two locales belong to the same group AND
 * are not the same locale. Used to detect "cross-group opportunity"
 * candidates in the autopilot.
 */
export function isSameLocaleGroup(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return false;
  const ga = getLocaleGroup(a);
  const gb = getLocaleGroup(b);
  return ga !== null && gb !== null && ga === gb;
}
