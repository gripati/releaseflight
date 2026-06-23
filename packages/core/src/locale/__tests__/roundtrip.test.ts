/**
 * Locale round-trip integration test — sweeps the canonical locale set
 * through BOTH Apple and Google converters and asserts that:
 *   1. Every canonical locale produces a non-empty target code.
 *   2. Google's known quirks (Hebrew = iw, Chinese = zh-CN / zh-TW) hold.
 *   3. Apple's regional variants degrade gracefully (es-419 → es-MX).
 *   4. A locale set on one platform does NOT silently corrupt the other.
 */
import { describe, expect, test } from "vitest";
import {
  toAppleLocale,
  toGooglePlayLocale,
  isGooglePlaySupported,
  APPLE_LOCALE_MAP,
  GOOGLE_PLAY_SUPPORTED_LANGUAGES,
} from "../index";

const CANONICAL_LOCALES = [
  "en", "en-US", "en-GB",
  "tr", "tr-TR",
  "de", "fr", "es", "es-MX", "es-419", "pt", "pt-BR", "it", "nl",
  "ru", "uk", "pl", "cs", "sk", "hu", "ro",
  "ja", "ja-JP", "ko", "ko-KR",
  "zh-Hans", "zh-Hant", "zh-CN", "zh-TW",
  "ar", "he", "he-IL",
  "th", "vi", "id", "ms",
  "hi", "ta", "bn",
];

describe("locale round-trip", () => {
  test("every canonical locale produces a non-empty Apple code", () => {
    for (const loc of CANONICAL_LOCALES) {
      const apple = toAppleLocale(loc);
      expect(apple.length).toBeGreaterThan(0);
    }
  });

  test("every canonical locale produces a non-empty Google code", () => {
    for (const loc of CANONICAL_LOCALES) {
      const g = toGooglePlayLocale(loc);
      expect(g.length).toBeGreaterThan(0);
    }
  });

  test("Apple converter is stable: A→A (idempotent on already-Apple inputs)", () => {
    for (const appleCode of Object.values(APPLE_LOCALE_MAP)) {
      expect(toAppleLocale(appleCode)).toBe(appleCode);
    }
  });

  test("Google's Hebrew quirk: he-IL → iw-IL on Google, but he stays he on Apple", () => {
    expect(toGooglePlayLocale("he-IL")).toBe("iw-IL");
    expect(toGooglePlayLocale("he")).toBe("iw-IL");
    expect(toAppleLocale("he-IL")).toBe("he");
    // Sanity: iw is *only* known to Google, not Apple — Apple should not produce iw
    expect(toAppleLocale("he-IL")).not.toContain("iw");
  });

  test("Chinese script ↔ region disambiguation", () => {
    expect(toGooglePlayLocale("zh-Hans")).toBe("zh-CN");
    expect(toGooglePlayLocale("zh-Hant")).toBe("zh-TW");
    expect(toAppleLocale("zh-CN")).toBe("zh-Hans");
    expect(toAppleLocale("zh-TW")).toBe("zh-Hant");
  });

  test("Spanish Latin America (es-419) maps correctly per platform", () => {
    expect(toGooglePlayLocale("es-419")).toBe("es-419");
    expect(toAppleLocale("es-419")).toBe("es-MX");
  });

  test("isGooglePlaySupported is exactly the source-of-truth set", () => {
    for (const code of GOOGLE_PLAY_SUPPORTED_LANGUAGES) {
      expect(isGooglePlaySupported(code)).toBe(true);
    }
    expect(isGooglePlaySupported("xx-YY")).toBe(false);
    expect(isGooglePlaySupported("he-IL")).toBe(false);
  });

  test("no canonical locale collapses to the empty string under either converter", () => {
    for (const loc of CANONICAL_LOCALES) {
      const a = toAppleLocale(loc);
      const g = toGooglePlayLocale(loc);
      expect(a).not.toBe("");
      expect(g).not.toBe("");
    }
  });
});
