import { describe, expect, test } from "vitest";
import {
  getLocaleGroup,
  getLocaleGroupMembers,
  isSameLocaleGroup,
} from "../groups";

describe("getLocaleGroup", () => {
  test.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["en-CA", "en"],
    ["en-AU", "en"],
    ["en-NZ", "en"],
    ["en", "en"],
    ["es-ES", "es"],
    ["es-MX", "es"],
    ["es-AR", "es"],
    ["fr-FR", "fr"],
    ["fr-CA", "fr"],
    ["pt-PT", "pt"],
    ["pt-BR", "pt"],
    ["de-DE", "de"],
    ["de-AT", "de"],
    ["nl-NL", "nl"],
    ["nl-BE", "nl"],
    ["zh-CN", "zh-hans"],
    ["zh-Hans", "zh-hans"],
    ["zh-HK", "zh-hant"],
    ["zh-TW", "zh-hant"],
    ["ar-SA", "ar"],
    ["ar-AE", "ar"],
  ] as const)("%s → %s", (locale, expected) => {
    expect(getLocaleGroup(locale)).toBe(expected);
  });

  test("case-insensitive", () => {
    expect(getLocaleGroup("EN-US")).toBe("en");
    expect(getLocaleGroup("en-us")).toBe("en");
    expect(getLocaleGroup("EN-us")).toBe("en");
  });

  test("returns null for unknown locales (singletons)", () => {
    expect(getLocaleGroup("ja-JP")).toBeNull();
    expect(getLocaleGroup("ko-KR")).toBeNull();
    expect(getLocaleGroup("ru-RU")).toBeNull();
    expect(getLocaleGroup("tr-TR")).toBeNull();
    expect(getLocaleGroup("cs-CZ")).toBeNull();
  });

  test("returns null for null/empty input", () => {
    expect(getLocaleGroup(null)).toBeNull();
    expect(getLocaleGroup(undefined)).toBeNull();
    expect(getLocaleGroup("")).toBeNull();
  });
});

describe("getLocaleGroupMembers", () => {
  test("English group includes all en-* storefronts", () => {
    const members = getLocaleGroupMembers("en-US");
    expect(members).toContain("en-us");
    expect(members).toContain("en-gb");
    expect(members).toContain("en-ca");
    expect(members).toContain("en-au");
    expect(members.length).toBeGreaterThanOrEqual(6);
  });

  test("Chinese Hans group does NOT include Hant", () => {
    const hans = getLocaleGroupMembers("zh-CN");
    expect(hans).toContain("zh-cn");
    expect(hans).toContain("zh-hans");
    expect(hans).not.toContain("zh-tw");
    expect(hans).not.toContain("zh-hk");
  });

  test("Chinese Hant group does NOT include Hans", () => {
    const hant = getLocaleGroupMembers("zh-TW");
    expect(hant).toContain("zh-tw");
    expect(hant).toContain("zh-hk");
    expect(hant).not.toContain("zh-cn");
  });

  test("unknown locale returns singleton (just itself)", () => {
    expect(getLocaleGroupMembers("ja-JP")).toEqual(["ja-JP"]);
  });
});

describe("isSameLocaleGroup", () => {
  test("returns true for documented in-group pairs", () => {
    expect(isSameLocaleGroup("en-US", "en-GB")).toBe(true);
    expect(isSameLocaleGroup("en-US", "en-CA")).toBe(true);
    expect(isSameLocaleGroup("fr-FR", "fr-CA")).toBe(true);
    expect(isSameLocaleGroup("es-MX", "es-ES")).toBe(true);
    expect(isSameLocaleGroup("de-DE", "de-CH")).toBe(true);
  });

  test("returns false for same-locale comparisons", () => {
    expect(isSameLocaleGroup("en-US", "en-US")).toBe(false);
    expect(isSameLocaleGroup("EN-US", "en-us")).toBe(false);
  });

  test("returns false for cross-group pairs", () => {
    expect(isSameLocaleGroup("en-US", "fr-FR")).toBe(false);
    expect(isSameLocaleGroup("zh-CN", "zh-TW")).toBe(false);
    expect(isSameLocaleGroup("es-MX", "pt-BR")).toBe(false);
  });

  test("returns false when either locale is a singleton", () => {
    expect(isSameLocaleGroup("ja-JP", "ko-KR")).toBe(false);
    expect(isSameLocaleGroup("en-US", "ja-JP")).toBe(false);
  });
});
