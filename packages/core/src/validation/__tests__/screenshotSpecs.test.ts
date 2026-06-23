import { describe, expect, test } from "vitest";
import {
  IOS_SCREENSHOT_SPECS,
  screenshotToPreviewType,
  validateIosScreenshot,
} from "../screenshotSpecs";

describe("validateIosScreenshot", () => {
  test("APP_IPHONE_67 accepts 1290×2796", () => {
    const r = validateIosScreenshot({
      displayType: "APP_IPHONE_67",
      width: 1290,
      height: 2796,
      fileSizeBytes: 1_000_000,
      mimeType: "image/png",
    });
    expect(r.ok).toBe(true);
  });

  test("rejects file over 8 MB", () => {
    const r = validateIosScreenshot({
      displayType: "APP_IPHONE_65",
      width: 1284,
      height: 2778,
      fileSizeBytes: 10 * 1024 * 1024,
      mimeType: "image/png",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("too large"))).toBe(true);
  });

  test("rejects wrong dimensions", () => {
    const r = validateIosScreenshot({
      displayType: "APP_IPHONE_65",
      width: 800,
      height: 600,
      fileSizeBytes: 100_000,
      mimeType: "image/png",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Invalid dimensions"))).toBe(true);
  });

  test("rejects non-PNG/JPEG mime", () => {
    const r = validateIosScreenshot({
      displayType: "APP_IPHONE_65",
      width: 1284,
      height: 2778,
      fileSizeBytes: 100_000,
      mimeType: "image/heic",
    });
    expect(r.ok).toBe(false);
  });

  test("unknown displayType — warns but does not reject", () => {
    const r = validateIosScreenshot({
      displayType: "APP_FAKE_DEVICE",
      width: 1000,
      height: 2000,
      fileSizeBytes: 100_000,
      mimeType: "image/png",
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("screenshotToPreviewType", () => {
  test.each<[string, string]>([
    ["APP_IPHONE_65", "IPHONE_65"],
    ["APP_IPAD_PRO_3GEN_129", "IPAD_PRO_3GEN_129"],
    ["IPHONE_65", "IPHONE_65"],
  ])("strips APP_ prefix: %s → %s", (input, expected) => {
    expect(screenshotToPreviewType(input)).toBe(expected);
  });
});

describe("IOS_SCREENSHOT_SPECS sanity", () => {
  test("every spec has at least one valid size", () => {
    for (const spec of Object.values(IOS_SCREENSHOT_SPECS)) {
      expect(spec.validSizes.length).toBeGreaterThan(0);
    }
  });

  test("PRIMARY device types exist", () => {
    const primaries = Object.values(IOS_SCREENSHOT_SPECS).filter((s) => s.isPrimary);
    expect(primaries.length).toBeGreaterThanOrEqual(3);
  });
});
