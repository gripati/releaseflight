import { describe, expect, test } from "vitest";
import { detectVideoMagicBytes } from "../videoMagicBytes";

function buildBuf(brand: string, offsetBytes: Buffer = Buffer.alloc(4)): Buffer {
  // bytes 0..3 are arbitrary (size field), then "ftyp" at 4..7, then brand at 8..11
  return Buffer.concat([
    offsetBytes,
    Buffer.from("ftyp", "ascii"),
    Buffer.from(brand.padEnd(4, " "), "ascii"),
  ]);
}

describe("detectVideoMagicBytes", () => {
  test("recognises QuickTime", () => {
    const r = detectVideoMagicBytes(buildBuf("qt  "));
    expect(r.ok).toBe(true);
    expect(r.format).toBe("quicktime");
  });

  test("recognises M4V", () => {
    const r = detectVideoMagicBytes(buildBuf("M4V "));
    expect(r.ok).toBe(true);
    expect(r.format).toBe("m4v");
  });

  test.each(["isom", "mp42", "iso2", "avc1"])("recognises MP4 brand %s", (brand) => {
    const r = detectVideoMagicBytes(buildBuf(brand));
    expect(r.ok).toBe(true);
    expect(r.format).toBe("mp4");
  });

  test("rejects buffer without ftyp marker", () => {
    const r = detectVideoMagicBytes(Buffer.from("PNG signature here    "));
    expect(r.ok).toBe(false);
  });

  test("rejects buffer too short", () => {
    const r = detectVideoMagicBytes(Buffer.alloc(5));
    expect(r.ok).toBe(false);
  });

  test("unknown brand is accepted with warning", () => {
    const r = detectVideoMagicBytes(buildBuf("xxxx"));
    expect(r.ok).toBe(true);
    expect(r.message).toBeDefined();
  });
});
