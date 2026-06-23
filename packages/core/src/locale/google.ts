/**
 * Google Play Console locale handling.
 *
 * Canonical (master JSON) locale → Google Play locale.
 *
 * IMPORTANT: The locale list is extracted DIRECTLY from the Google Play
 * Console "Add or remove languages" dialog (per LocaleConverter.cs:31-124
 * in the Unity reference). These are the EXACT codes Google accepts —
 * do not change unless Google changes them. Notable quirks:
 *   • Hebrew uses the LEGACY ISO code "iw-IL" (not "he-IL")
 *   • Spanish Latin America is "es-419"
 *   • Chinese Simplified is "zh-CN" (Google), not "zh-Hans" (Apple)
 */

export const GOOGLE_PLAY_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  // Asian / Pacific
  "ca", "zh-HK", "zh-CN", "zh-TW", "hr", "cs-CZ", "da-DK", "nl-NL",
  "en-AU", "en-CA", "en-US", "en-IN", "en-SG", "en-ZA", "en-GB",
  "et", "fil", "fi-FI", "fr-CA", "fr-FR", "gl-ES", "ka-GE", "de-DE",
  "el-GR", "gu", "iw-IL", "hi-IN", "hu-HU", "is-IS", "id",
  "it-IT", "ja-JP", "kn-IN", "kk", "km-KH", "ko-KR", "ky-KG", "lo-LA",
  "lv", "lt",

  // Additional from Google Play docs
  "af", "am-ET", "ar", "az-AZ", "eu-ES", "be-BY", "bn-BD",
  "bg-BG", "my-MM", "mk-MK", "ml-IN", "mr-IN", "mn-MN", "ne-NP",
  "nb-NO", "fa-IR", "pl-PL", "pt-BR", "pt-PT", "pa-IN", "ro", "ru-RU",
  "sr", "si-LK", "sk", "sl-SI", "es-419", "es-ES", "es-US", "ms-MY",
  "sw", "sv-SE", "ta-IN", "te-IN", "th", "tr-TR", "uk", "ur-PK",
  "uz-UZ", "vi", "zu-ZA", "sq",
]);

const GOOGLE_MAP: Readonly<Record<string, string>> = {
  // English variants → default to en-US
  "en": "en-US",
  "en-US": "en-US",

  // Turkish
  "tr": "tr-TR",
  "tr-TR": "tr-TR",

  // CJK
  "ja": "ja-JP",
  "ja-JP": "ja-JP",
  "ko": "ko-KR",
  "ko-KR": "ko-KR",
  "zh-Hans": "zh-CN",
  "zh-CN": "zh-CN",
  "zh-Hant": "zh-TW",
  "zh-TW": "zh-TW",

  // Hebrew (Google's quirk)
  "he": "iw-IL",
  "he-IL": "iw-IL",

  // Spanish family
  "es": "es-ES",
  "es-MX": "es-419",
  "es-419": "es-419",

  // Portuguese
  "pt": "pt-PT",

  // Arabic
  "ar-SA": "ar",
  "ar": "ar",

  // German/French defaults
  "de": "de-DE",
  "fr": "fr-FR",
  "it": "it-IT",
  "ru": "ru-RU",
  "hi": "hi-IN",
  "nl": "nl-NL",
};

export function toGooglePlayLocale(canonical: string): string {
  if (!canonical) return canonical;

  if (GOOGLE_MAP[canonical]) return GOOGLE_MAP[canonical];
  if (GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(canonical)) return canonical;

  const base = canonical.split("-")[0];
  if (base) {
    if (GOOGLE_MAP[base]) return GOOGLE_MAP[base];
    if (GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(base)) return base;
  }

  // Caller must inspect — locale unsupported by Google
  return canonical;
}

export function isGooglePlaySupported(googleLocale: string): boolean {
  return GOOGLE_PLAY_SUPPORTED_LANGUAGES.has(googleLocale);
}
