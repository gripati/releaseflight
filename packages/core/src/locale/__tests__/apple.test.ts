import { describe, expect, test } from "vitest";
import {
  toAppleLocale,
  territoryDisplay,
  territoryFlag,
  territoryName,
} from "../apple";

describe("toAppleLocale", () => {
  test.each<[string, string]>([
    ["en-US", "en-US"],
    ["en", "en-US"],
    ["tr", "tr"],
    ["tr-TR", "tr"],
    ["he", "he"],
    ["he-IL", "he"],
    ["zh-Hans", "zh-Hans"],
    ["zh-CN", "zh-Hans"],
    ["zh-Hant", "zh-Hant"],
    ["zh-TW", "zh-Hant"],
    ["ja", "ja"],
    ["es-MX", "es-MX"],
    ["es-419", "es-MX"],
  ])("toAppleLocale(%j) → %j", (input, expected) => {
    expect(toAppleLocale(input)).toBe(expected);
  });

  test("unknown locale returned as-is", () => {
    expect(toAppleLocale("xx-YY")).toBe("xx-YY");
  });
});

describe("territoryFlag / territoryName / territoryDisplay", () => {
  test("converts common 2-letter codes to flag emojis", () => {
    expect(territoryFlag("US")).toBe("🇺🇸");
    expect(territoryFlag("GB")).toBe("🇬🇧");
    expect(territoryFlag("TR")).toBe("🇹🇷");
    expect(territoryFlag("JP")).toBe("🇯🇵");
    expect(territoryFlag("DE")).toBe("🇩🇪");
  });

  test("lowercases input + handles whitespace", () => {
    expect(territoryFlag("us")).toBe("🇺🇸");
    expect(territoryFlag("  fr  ")).toBe("🇫🇷");
  });

  test("returns neutral white flag for invalid codes", () => {
    expect(territoryFlag("")).toBe("🏳️");
    expect(territoryFlag("USA")).toBe("🏳️");
    expect(territoryFlag("X")).toBe("🏳️");
  });

  test("territoryName returns full country name via Intl.DisplayNames", () => {
    expect(territoryName("US")).toBe("United States");
    expect(territoryName("GB")).toBe("United Kingdom");
    expect(territoryName("TR")).toBe("Türkiye");
    expect(territoryName("JP")).toBe("Japan");
  });

  test("territoryName falls back to the raw code on unknown", () => {
    expect(territoryName("XZ")).toBe("XZ");
  });

  test("territoryDisplay combines flag + country name", () => {
    expect(territoryDisplay("US")).toBe("🇺🇸 United States");
    expect(territoryDisplay("DE")).toBe("🇩🇪 Germany");
  });
});
