import { describe, expect, test } from "vitest";
import {
  toGooglePlayLocale,
  isGooglePlaySupported,
  GOOGLE_PLAY_SUPPORTED_LANGUAGES,
} from "../google";

describe("toGooglePlayLocale — canonical → Google Play codes", () => {
  test.each<[string, string]>([
    ["en", "en-US"],
    ["en-US", "en-US"],
    ["tr", "tr-TR"],
    ["tr-TR", "tr-TR"],
    ["he", "iw-IL"],
    ["he-IL", "iw-IL"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hant", "zh-TW"],
    ["zh-CN", "zh-CN"],
    ["es-MX", "es-419"],
    ["es-419", "es-419"],
    ["ja", "ja-JP"],
    ["ja-JP", "ja-JP"],
    ["ko", "ko-KR"],
    ["nl", "nl-NL"],
  ])("toGooglePlayLocale(%j) → %j", (input, expected) => {
    expect(toGooglePlayLocale(input)).toBe(expected);
  });

  test("unsupported locale falls through to base or original", () => {
    // fr-CH is unsupported; we return as-is so the caller can record it
    expect(toGooglePlayLocale("fr-CH")).toBe("fr-FR"); // base 'fr' maps to fr-FR
    expect(toGooglePlayLocale("xx-YY")).toBe("xx-YY");
  });
});

describe("isGooglePlaySupported", () => {
  test("recognises Hebrew as iw-IL not he-IL", () => {
    expect(isGooglePlaySupported("iw-IL")).toBe(true);
    expect(isGooglePlaySupported("he-IL")).toBe(false);
  });

  test("recognises all advertised locales", () => {
    expect(isGooglePlaySupported("tr-TR")).toBe(true);
    expect(isGooglePlaySupported("es-419")).toBe(true);
    expect(isGooglePlaySupported("zh-CN")).toBe(true);
    expect(isGooglePlaySupported("fr-CH")).toBe(false);
  });

  test("set is not empty", () => {
    expect(GOOGLE_PLAY_SUPPORTED_LANGUAGES.size).toBeGreaterThanOrEqual(70);
  });
});
