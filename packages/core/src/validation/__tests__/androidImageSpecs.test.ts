import { describe, expect, test } from "vitest";
import { validateAndroidImage } from "../androidImageSpecs";

describe("validateAndroidImage", () => {
  test("icon must be exactly 512×512", () => {
    const okR = validateAndroidImage({
      imageKind: "icon",
      width: 512,
      height: 512,
      fileSizeBytes: 100_000,
      mimeType: "image/png",
    });
    expect(okR.ok).toBe(true);

    const failR = validateAndroidImage({
      imageKind: "icon",
      width: 1024,
      height: 1024,
      fileSizeBytes: 100_000,
      mimeType: "image/png",
    });
    expect(failR.ok).toBe(false);
  });

  test("featureGraphic must be exactly 1024×500", () => {
    expect(
      validateAndroidImage({
        imageKind: "featureGraphic",
        width: 1024,
        height: 500,
        fileSizeBytes: 100_000,
        mimeType: "image/png",
      }).ok,
    ).toBe(true);
    expect(
      validateAndroidImage({
        imageKind: "featureGraphic",
        width: 800,
        height: 400,
        fileSizeBytes: 100_000,
        mimeType: "image/png",
      }).ok,
    ).toBe(false);
  });

  test("phoneScreenshots accepts any size in range", () => {
    expect(
      validateAndroidImage({
        imageKind: "phoneScreenshots",
        width: 1080,
        height: 1920,
        fileSizeBytes: 500_000,
        mimeType: "image/png",
      }).ok,
    ).toBe(true);
  });

  test("phoneScreenshots rejects below min size", () => {
    expect(
      validateAndroidImage({
        imageKind: "phoneScreenshots",
        width: 100,
        height: 100,
        fileSizeBytes: 500_000,
        mimeType: "image/png",
      }).ok,
    ).toBe(false);
  });
});
