import { describe, expect, test } from "vitest";
import { importMasterJson } from "../masterJson";

const sample = JSON.stringify({
  _schema: "1.0",
  _comment: "test",
  "en-US": {
    app_name: "Word Stack Solitaire",
    subtitle: "Word & Card Puzzle",
    description: "A long description.",
    keywords: "word,puzzle,brain",
    whats_new: "Bug fixes.",
    promotional_text: "Try it now!",
    marketing_url: "https://example.com",
    support_url: "https://example.com/support",
    privacy_policy_url: "https://example.com/privacy",
  },
  tr: {
    app_name: "Word Stack Solitaire",
    // Long enough to exceed the 4000-codepoint description limit
    description: "Türkçe açıklama — A".repeat(300),
  },
  // 'qq-ZZ' isn't in the Google Play accepted locale set and falls back
  // to itself (not a known base). Used to exercise unsupportedGooglePlay.
  "qq-ZZ": { app_name: "Imaginary" },
});

describe("importMasterJson", () => {
  test("parses iOS variant and maps snake_case fields", () => {
    const r = importMasterJson({ json: sample, platform: "IOS" });
    expect(r.parsedLocales).toBe(3);
    const en = r.actions.find((a) => a.canonicalLocale === "en-US");
    expect(en?.fields.name).toBe("Word Stack Solitaire");
    expect(en?.fields.subtitle).toBe("Word & Card Puzzle");
    expect(en?.fields.keywords).toBe("word,puzzle,brain");
    expect(en?.fields.whatsNew).toBe("Bug fixes.");
    expect(en?.fields.privacyPolicyUrl).toBe("https://example.com/privacy");
  });

  test("truncates fields over limit when truncateToLimits=true", () => {
    const r = importMasterJson({ json: sample, platform: "IOS", truncateToLimits: true });
    const tr = r.actions.find((a) => a.canonicalLocale === "tr");
    expect(tr?.fields.description?.length).toBeLessThanOrEqual(4000);
    const trunc = r.truncated.find((t) => t.locale === "tr" && t.field === "description");
    expect(trunc).toBeDefined();
  });

  test("rejects overflowing field when truncateToLimits=false", () => {
    const big = JSON.stringify({
      en: { app_name: "X".repeat(80) },
    });
    const r = importMasterJson({ json: big, platform: "IOS", truncateToLimits: false });
    expect(r.actions.length).toBe(0);
    expect(r.failed[0]?.locale).toBe("en");
  });

  test("flags Google Play unsupported locales on ANDROID platform", () => {
    const r = importMasterJson({ json: sample, platform: "ANDROID" });
    expect(r.unsupportedGooglePlay).toContain("qq-ZZ");
  });

  test("dry-run-safe: pure function, no side effects", () => {
    const r1 = importMasterJson({ json: sample, platform: "IOS" });
    const r2 = importMasterJson({ json: sample, platform: "IOS" });
    expect(r1.actions.length).toBe(r2.actions.length);
  });

  test("invalid JSON throws", () => {
    expect(() => importMasterJson({ json: "{ not json", platform: "IOS" })).toThrow();
  });
});
