/**
 * Apple App Store Connect locale handling.
 * Canonical (master JSON) locale → Apple locale.
 *
 * Source: Unity reference implementation (LocaleConverter.cs:258-390)
 * augmented with App Store Connect API documentation.
 */

const APPLE_MAP: Readonly<Record<string, string>> = {
  // English variants
  en: "en-US",
  "en-US": "en-US",
  "en-GB": "en-GB",
  "en-CA": "en-CA",
  "en-AU": "en-AU",

  // Turkish
  tr: "tr",
  "tr-TR": "tr",

  // CJK
  ja: "ja",
  "ja-JP": "ja",
  ko: "ko",
  "ko-KR": "ko",
  "zh-Hans": "zh-Hans",
  "zh-CN": "zh-Hans",
  "zh-Hant": "zh-Hant",
  "zh-TW": "zh-Hant",
  "zh-HK": "zh-HK",

  // Hebrew  — Apple uses "he", Google uses "iw-IL" (legacy ISO)
  he: "he",
  "he-IL": "he",

  // Arabic
  ar: "ar-SA",
  "ar-SA": "ar-SA",

  // European (Spanish family)
  es: "es-ES",
  "es-ES": "es-ES",
  "es-MX": "es-MX",
  "es-419": "es-MX",

  // Portuguese
  pt: "pt-PT",
  "pt-PT": "pt-PT",
  "pt-BR": "pt-BR",

  // French
  fr: "fr-FR",
  "fr-FR": "fr-FR",
  "fr-CA": "fr-CA",

  // German
  de: "de-DE",
  "de-DE": "de-DE",

  // Italian
  it: "it",
  "it-IT": "it",

  // Russian
  ru: "ru",
  "ru-RU": "ru",

  // Dutch
  nl: "nl-NL",
  "nl-NL": "nl-NL",

  // Nordic
  sv: "sv",
  "sv-SE": "sv",
  da: "da",
  "da-DK": "da",
  no: "no",
  nb: "no",
  "nb-NO": "no",
  fi: "fi",
  "fi-FI": "fi",

  // Central European
  pl: "pl",
  "pl-PL": "pl",
  cs: "cs",
  "cs-CZ": "cs",
  sk: "sk",
  hu: "hu",
  "hu-HU": "hu",
  el: "el",
  "el-GR": "el",
  ro: "ro",

  // Eastern European
  uk: "uk",
  ca: "ca",
  hr: "hr",

  // Asian
  id: "id",
  ms: "ms",
  th: "th",
  vi: "vi",
  hi: "hi",
  "hi-IN": "hi",
};

export const APPLE_LOCALE_MAP: Readonly<Record<string, string>> = APPLE_MAP;

export function toAppleLocale(canonical: string): string {
  if (!canonical) return canonical;
  if (APPLE_MAP[canonical]) return APPLE_MAP[canonical];

  const base = canonical.split("-")[0];
  if (base && APPLE_MAP[base]) return APPLE_MAP[base];

  // Apple will validate; return as-is for unknown codes
  return canonical;
}

/**
 * Canonical English display name per App Store / Play Store locale.
 *
 * Apple's own admin UI labels locales in English (e.g. "Turkish",
 * "Spanish (Mexico)") rather than native script — easier to scan when
 * a publisher has 20+ locales open at once. Release Flight mirrors that.
 *
 * Anything not in this map falls back through:
 *   1. Direct match
 *   2. Language-only match ("bg" → "Bulgarian")
 *   3. Intl.DisplayNames (browser/Node built-in, when available)
 *   4. The raw locale code, last resort
 */
const LOCALE_NAMES: Readonly<Record<string, string>> = {
  "en-US": "English (U.S.)",
  "en-GB": "English (U.K.)",
  "en-CA": "English (Canada)",
  "en-AU": "English (Australia)",
  tr: "Turkish",
  "tr-TR": "Turkish",
  ja: "Japanese",
  "ja-JP": "Japanese",
  ko: "Korean",
  "ko-KR": "Korean",
  "zh-Hans": "Chinese (Simplified)",
  "zh-CN": "Chinese (Simplified)",
  "zh-Hant": "Chinese (Traditional)",
  "zh-TW": "Chinese (Traditional)",
  "zh-HK": "Chinese (Hong Kong)",
  he: "Hebrew",
  "he-IL": "Hebrew",
  "iw-IL": "Hebrew",
  ar: "Arabic",
  "ar-SA": "Arabic",
  "es-ES": "Spanish (Spain)",
  "es-MX": "Spanish (Mexico)",
  "es-419": "Spanish (Latin America)",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "fr-FR": "French",
  "fr-CA": "French (Canada)",
  de: "German",
  "de-DE": "German",
  it: "Italian",
  "it-IT": "Italian",
  ru: "Russian",
  "ru-RU": "Russian",
  nl: "Dutch",
  "nl-NL": "Dutch",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  nb: "Norwegian",
  fi: "Finnish",
  pl: "Polish",
  cs: "Czech",
  sk: "Slovak",
  hu: "Hungarian",
  el: "Greek",
  ro: "Romanian",
  uk: "Ukrainian",
  id: "Indonesian",
  ms: "Malay",
  th: "Thai",
  vi: "Vietnamese",
  hi: "Hindi",
  hr: "Croatian",
  ca: "Catalan",
  bg: "Bulgarian",
  lv: "Latvian",
  lt: "Lithuanian",
  et: "Estonian",
  sl: "Slovenian",
  sr: "Serbian",
  fa: "Persian",
  ur: "Urdu",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  pa: "Punjabi",
  fil: "Filipino",
  az: "Azerbaijani",
  kk: "Kazakh",
  uz: "Uzbek",
  be: "Belarusian",
  ka: "Georgian",
  hy: "Armenian",
  is: "Icelandic",
  mt: "Maltese",
  sw: "Swahili",
  af: "Afrikaans",
  zu: "Zulu",
  xh: "Xhosa",
};

/** Bare-language fallbacks so unknown region codes still map cleanly. */
const LANG_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  ar: "Arabic",
  tr: "Turkish",
  he: "Hebrew",
  iw: "Hebrew",
  pl: "Polish",
  cs: "Czech",
  hu: "Hungarian",
  sv: "Swedish",
  no: "Norwegian",
  nb: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  ro: "Romanian",
  uk: "Ukrainian",
  el: "Greek",
  id: "Indonesian",
  ms: "Malay",
  th: "Thai",
  vi: "Vietnamese",
  hi: "Hindi",
};

export function localeName(locale: string): string {
  // 1. Direct map hit
  const direct = LOCALE_NAMES[locale];
  if (direct) return direct;

  const parts = locale.split(/[-_]/);
  const lang = parts[0]?.toLowerCase() ?? "";

  // 2. Language-only fallback ("bg" → "Bulgarian")
  if (LANG_NAMES[lang]) return LANG_NAMES[lang];

  // 3. Intl.DisplayNames — Node 18+ + every modern browser support this.
  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    const resolved = display.of(locale);
    if (resolved && resolved !== locale) return resolved;
    if (lang) {
      const langResolved = display.of(lang);
      if (langResolved && langResolved !== lang) return langResolved;
    }
  } catch {
    /* Intl.DisplayNames unavailable — fall through */
  }

  // 4. Raw locale as a last resort.
  return locale;
}

/**
 * Region (ISO 3166-1 alpha-2) that best represents a canonical locale.
 * Used for flag emojis and storefront mapping. Falls back to "UN" for
 * unknown inputs so callers get a neutral flag instead of a broken
 * one.
 */
const LOCALE_REGION: Readonly<Record<string, string>> = {
  "en-US": "US",
  "en-GB": "GB",
  "en-CA": "CA",
  "en-AU": "AU",
  tr: "TR",
  "tr-TR": "TR",
  ja: "JP",
  "ja-JP": "JP",
  ko: "KR",
  "ko-KR": "KR",
  "zh-Hans": "CN",
  "zh-CN": "CN",
  "zh-Hant": "TW",
  "zh-TW": "TW",
  "zh-HK": "HK",
  he: "IL",
  "he-IL": "IL",
  "iw-IL": "IL",
  ar: "SA",
  "ar-SA": "SA",
  "es-ES": "ES",
  "es-MX": "MX",
  "es-419": "MX",
  "pt-BR": "BR",
  "pt-PT": "PT",
  "fr-FR": "FR",
  "fr-CA": "CA",
  "de-DE": "DE",
  de: "DE",
  it: "IT",
  "it-IT": "IT",
  ru: "RU",
  "ru-RU": "RU",
  "nl-NL": "NL",
  nl: "NL",
  sv: "SE",
  da: "DK",
  no: "NO",
  nb: "NO",
  fi: "FI",
  pl: "PL",
  cs: "CZ",
  sk: "SK",
  hu: "HU",
  el: "GR",
  ro: "RO",
  uk: "UA",
  id: "ID",
  ms: "MY",
  th: "TH",
  vi: "VN",
  hi: "IN",
  hr: "HR",
  ca: "ES",
  bg: "BG",
};

export function localeRegion(locale: string): string {
  const direct = LOCALE_REGION[locale];
  if (direct) return direct;
  const parts = locale.split(/[-_]/);
  if (parts.length >= 2) {
    const region = parts[parts.length - 1]!.toUpperCase();
    if (/^[A-Z]{2}$/.test(region)) return region;
    if (region === "HANS") return "CN";
    if (region === "HANT") return "TW";
  }
  const langOnly = parts[0]?.toLowerCase();
  if (langOnly && LOCALE_REGION[langOnly]) return LOCALE_REGION[langOnly];
  return "UN";
}

/** Convert a 2-letter region code into a unicode regional-indicator flag. */
export function localeFlag(locale: string): string {
  const region = localeRegion(locale);
  if (region.length !== 2) return "🏳️";
  const a = region.charCodeAt(0) - 65;
  const b = region.charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) return "🏳️";
  return String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + b);
}

/**
 * Convert a raw 2-letter ISO 3166-1 alpha-2 country code (e.g. the
 * `territory` column on TrackedKeyword: "US", "GB", "TR") into a
 * flag emoji. Distinct from `localeFlag` which expects a full locale
 * like "en-US".
 */
export function territoryFlag(code: string): string {
  const region = (code ?? "").trim().toUpperCase();
  if (region.length !== 2) return "🏳️";
  const a = region.charCodeAt(0) - 65;
  const b = region.charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) return "🏳️";
  return String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + b);
}

/**
 * Country name for a raw 2-letter ISO 3166-1 alpha-2 code. Uses
 * `Intl.DisplayNames(region)` so we don't ship our own 250-country
 * mapping. Falls back to the code itself on unknown input.
 */
export function territoryName(code: string): string {
  const region = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return code;
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    const name = display.of(region);
    return name && name !== region ? name : region;
  } catch {
    return region;
  }
}

/**
 * Combined chip-ready label: "🇺🇸 United States". Centralised here so
 * every UI surface uses the same format.
 */
export function territoryDisplay(code: string): string {
  return `${territoryFlag(code)} ${territoryName(code)}`;
}
